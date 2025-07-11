import Bluebird from 'bluebird'
import check from 'check-more-types'
import debugModule from 'debug'
import la from 'lazy-ass'
import _ from 'lodash'
import os from 'os'
import path from 'path'
import extension from '@packages/extension'
import mime from 'mime'
import { launch } from '@packages/launcher'

import appData from '../util/app_data'
import { fs } from '../util/fs'
import { CdpAutomation, screencastOpts } from './cdp_automation'
import * as protocol from './protocol'
import utils from './utils'
import * as errors from '../errors'
import { BrowserCriClient } from './browser-cri-client'
import type { Browser, BrowserInstance, GracefulShutdownOptions } from './types'
import type { CriClient } from './cri-client'
import type { Automation } from '../automation'
import memory from './memory'

import type { BrowserLaunchOpts, BrowserNewTabOpts, ProtocolManagerShape, RunModeVideoApi } from '@packages/types'
import type { CDPSocketServer } from '@packages/socket/lib/cdp-socket'
import { DEFAULT_CHROME_FLAGS } from '../util/chromium_flags'

const debug = debugModule('cypress:server:browsers:chrome')

const LOAD_EXTENSION = '--load-extension='
const CHROME_VERSIONS_WITH_BUGGY_ROOT_LAYER_SCROLLING = '66 67'.split(' ')
const CHROME_VERSION_INTRODUCING_PROXY_BYPASS_ON_LOOPBACK = 72
const CHROME_VERSION_WITH_FPS_INCREASE = 89
const CHROME_VERSION_INTRODUCING_HEADLESS_NEW = 112

const CHROME_PREFERENCE_PATHS = {
  default: path.join('Default', 'Preferences'),
  defaultSecure: path.join('Default', 'Secure Preferences'),
  localState: 'Local State',
}

type ChromePreferences = {
  default: object
  defaultSecure: object
  localState: object
}

const pathToExtension = extension.getPathToV3Extension()
const pathToTheme = extension.getPathToTheme()

let browserCriClient: BrowserCriClient | undefined

/**
 * Reads all known preference files (CHROME_PREFERENCE_PATHS) from disk and return
 * @param userDir
 */
const _getChromePreferences = (userDir: string): Bluebird<ChromePreferences> => {
  // skip reading the preferences if requested by the user,
  // typically used when the AUT encrypts the user data dir, causing relaunches of the browser not to work
  // see https://github.com/cypress-io/cypress/issues/29330
  if (process.env.IGNORE_CHROME_PREFERENCES) {
    debug('ignoring chrome preferences: not reading from chrome preference files')

    return Bluebird.resolve(_.mapValues(CHROME_PREFERENCE_PATHS, () => ({})))
  }

  debug('reading chrome preferences... %o', { userDir, CHROME_PREFERENCE_PATHS })

  return Bluebird.props(_.mapValues(CHROME_PREFERENCE_PATHS, (prefPath) => {
    return fs.readJson(path.join(userDir, prefPath))
    .catch((err) => {
      // return empty obj if it doesn't exist
      if (err.code === 'ENOENT') {
        return {}
      }

      throw err
    })
  }))
}

const _mergeChromePreferences = (originalPrefs: ChromePreferences, newPrefs: ChromePreferences): ChromePreferences => {
  return _.mapValues(CHROME_PREFERENCE_PATHS, (_v, prefPath) => {
    const original = _.cloneDeep(originalPrefs[prefPath])

    if (!newPrefs[prefPath]) {
      return original
    }

    let deletions: any[] = []

    _.mergeWith(original, newPrefs[prefPath], (_objValue, newValue, key, obj) => {
      if (newValue == null) {
        // setting a key to null should remove it
        deletions.push([obj, key])
      }
    })

    deletions.forEach(([obj, key]) => {
      delete obj[key]
    })

    return original
  })
}

const _writeChromePreferences = (userDir: string, originalPrefs: ChromePreferences, newPrefs: ChromePreferences): Promise<void> => {
  // skip writing the preferences if requested by the user,
  // typically used when the AUT encrypts the user data dir, causing relaunches of the browser not to work
  // see https://github.com/cypress-io/cypress/issues/29330
  if (process.env.IGNORE_CHROME_PREFERENCES) {
    debug('ignoring chrome preferences: not writing to preference files')

    return Promise.resolve()
  }

  return Bluebird.map(_.keys(originalPrefs), (key) => {
    const originalJson = originalPrefs[key]
    const newJson = newPrefs[key]

    if (!newJson || _.isEqual(originalJson, newJson)) {
      return
    }

    return fs.outputJson(path.join(userDir, CHROME_PREFERENCE_PATHS[key]), newJson)
  })
  .return()
}

/**
 * Merge the different `--load-extension` arguments into one.
 *
 * @param extPath path to Cypress extension
 * @param args all browser args
 * @param browser the current browser being launched
 * @returns the modified list of arguments
 */
const _normalizeArgExtensions = function (extPath, args, pluginExtensions, browser: Browser): string[] {
  if (browser.isHeadless) {
    return args
  }

  let userExtensions = []
  const loadExtension = _.find(args, (arg) => {
    return arg.includes(LOAD_EXTENSION)
  })

  if (loadExtension || pluginExtensions.length > 0) {
    // @see https://github.com/cypress-io/cypress/issues/31702
    if (Number(browser.majorVersion) >= 137 && browser.name === 'chrome') {
      // eslint-disable-next-line no-console
      errors.warning('CHROME_137_LOAD_EXTENSION_NOT_SUPPORTED')
    }
  }

  if (loadExtension) {
    args = _.without(args, loadExtension)

    // form into array, enabling users to pass multiple extensions
    userExtensions = userExtensions.concat(loadExtension.replace(LOAD_EXTENSION, '').split(','))
  }

  if (pluginExtensions) {
    userExtensions = userExtensions.concat(pluginExtensions)
  }

  const extensions = ([] as any).concat(userExtensions, extPath, pathToTheme)

  args.push(LOAD_EXTENSION + _.compact(extensions).join(','))

  return args
}

// we now store the extension in each browser profile
const _removeRootExtension = () => {
  return fs
  .removeAsync(appData.path('extensions'))
  .catchReturn(null)
} // noop if doesn't exist fails for any reason

// https://github.com/cypress-io/cypress/issues/2048
const _disableRestorePagesPrompt = function (userDir) {
  if (process.env.IGNORE_CHROME_PREFERENCES) {
    return Promise.resolve()
  }

  const prefsPath = path.join(userDir, 'Default', 'Preferences')

  return fs.readJson(prefsPath)
  .then((preferences) => {
    const profile = preferences.profile

    if (profile) {
      if ((profile['exit_type'] !== 'Normal') || (profile['exited_cleanly'] !== true)) {
        debug('cleaning up unclean exit status')

        profile['exit_type'] = 'Normal'
        profile['exited_cleanly'] = true

        return fs.outputJson(prefsPath, preferences)
      }
    }

    return
  })
  .catch(() => { })
}

async function _recordVideo (cdpAutomation: CdpAutomation, videoOptions: RunModeVideoApi, browserMajorVersion: number) {
  const screencastOptions = browserMajorVersion >= CHROME_VERSION_WITH_FPS_INCREASE ? screencastOpts() : screencastOpts(1)

  const { writeVideoFrame } = await videoOptions.useFfmpegVideoController()

  await cdpAutomation.startVideoRecording(writeVideoFrame, screencastOptions)
}

// a utility function that navigates to the given URL
// once Chrome remote interface client is passed to it.
const _navigateUsingCRI = async function (client, url) {
  // @ts-ignore
  la(check.url(url), 'missing url to navigate to', url)
  la(client, 'could not get CRI client')
  debug('received CRI client')
  debug('navigating to page %s', url)

  // when opening the blank page and trying to navigate
  // the focus gets lost. Restore it and then navigate.
  await client.send('Page.bringToFront')
  await client.send('Page.navigate', { url })
}

const _handleDownloads = async function (client, downloadsFolder: string, automation) {
  client.on('Page.downloadWillBegin', (data) => {
    const downloadItem = {
      id: data.guid,
      url: data.url,
    }

    const filename = data.suggestedFilename

    if (filename) {
      // @ts-ignore
      downloadItem.filePath = path.join(downloadsFolder, data.suggestedFilename)
      // @ts-ignore
      downloadItem.mime = mime.getType(data.suggestedFilename)
    }

    automation.push('create:download', downloadItem)
  })

  client.on('Page.downloadProgress', (data) => {
    if (data.state === 'completed') {
      automation.push('complete:download', {
        id: data.guid,
      })
    }

    if (data.state === 'canceled') {
      automation.push('canceled:download', {
        id: data.guid,
      })
    }
  })

  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadsFolder,
  })
}

let onReconnect: (client: CriClient) => Promise<void> = async () => undefined

const _setAutomation = async (client: CriClient, automation: Automation, resetBrowserTargets: (shouldKeepTabOpen: boolean) => Promise<void>, options: BrowserLaunchOpts) => {
  const cdpAutomation = await CdpAutomation.create(client.send, client.on, client.off, resetBrowserTargets, automation, options.protocolManager, true, options.isTextTerminal)

  automation.use(cdpAutomation)

  return cdpAutomation
}

export = {
  //
  // tip:
  //   by adding utility functions that start with "_"
  //   as methods here we can easily stub them from our unit tests
  //

  _normalizeArgExtensions,

  _removeRootExtension,

  _recordVideo,

  _navigateUsingCRI,

  _handleDownloads,

  _setAutomation,

  _getChromePreferences,

  _mergeChromePreferences,

  _writeChromePreferences,

  _getBrowserCriClient () {
    return browserCriClient
  },

  async _writeExtension (browser: Browser, options: BrowserLaunchOpts) {
    if (browser.isHeadless) {
      debug('chrome is running headlessly, not installing extension')

      return
    }

    const extensionDest = utils.getExtensionDir(browser, options.isTextTerminal)

    // copy the extension src to the extension dist
    await utils.copyExtension(pathToExtension, extensionDest)

    return extensionDest
  },

  _getArgs (browser: Browser, options: BrowserLaunchOpts, port: string) {
    const args = ([] as string[]).concat(DEFAULT_CHROME_FLAGS)

    if (os.platform() === 'linux') {
      args.push('--disable-gpu')
      args.push('--no-sandbox')
    }

    const ua = options.userAgent

    if (ua) {
      args.push(`--user-agent=${ua}`)
    }

    const ps = options.proxyServer

    if (ps) {
      args.push(`--proxy-server=${ps}`)
    }

    if (options.chromeWebSecurity === false) {
      args.push('--disable-web-security')
      args.push('--allow-running-insecure-content')
    }

    // prevent AUT shaking in 66 & 67, but flag breaks chrome in 68+
    // https://github.com/cypress-io/cypress/issues/2037
    // https://github.com/cypress-io/cypress/issues/2215
    // https://github.com/cypress-io/cypress/issues/2223
    const { majorVersion, isHeadless } = browser

    if (CHROME_VERSIONS_WITH_BUGGY_ROOT_LAYER_SCROLLING.includes(majorVersion)) {
      args.push('--disable-blink-features=RootLayerScrolling')
    }

    // https://chromium.googlesource.com/chromium/src/+/da790f920bbc169a6805a4fb83b4c2ab09532d91
    // https://github.com/cypress-io/cypress/issues/1872
    if (Number(majorVersion) >= CHROME_VERSION_INTRODUCING_PROXY_BYPASS_ON_LOOPBACK) {
      args.push('--proxy-bypass-list=<-loopback>')
    }

    if (isHeadless) {
      if (Number(majorVersion) >= CHROME_VERSION_INTRODUCING_HEADLESS_NEW) {
        args.push('--headless=new')
      } else {
        args.push('--headless')
      }

      // set default headless size to 1280x720
      // https://github.com/cypress-io/cypress/issues/6210
      args.push('--window-size=1280,720')

      // set default headless DPR to 1
      // https://github.com/cypress-io/cypress/issues/17375
      args.push('--force-device-scale-factor=1')
    }

    // force ipv4
    // https://github.com/cypress-io/cypress/issues/5912
    args.push(`--remote-debugging-port=${port}`)
    args.push('--remote-debugging-address=127.0.0.1')

    return args
  },

  /**
  * Clear instance state for the chrome instance, this is normally called in on kill or on exit.
  */
  clearInstanceState (options: GracefulShutdownOptions = {}) {
    debug('closing remote interface client', { options })
    // Do nothing on failure here since we're shutting down anyway
    browserCriClient?.close(options.gracefulShutdown).catch(() => {})
    browserCriClient = undefined
  },

  async connectProtocolToBrowser (options: { protocolManager?: ProtocolManagerShape }) {
    const browserCriClient = this._getBrowserCriClient()

    if (!browserCriClient?.currentlyAttachedTarget) throw new Error('Missing pageCriClient in connectProtocolToBrowser')

    // Clone the target here so that we separate the protocol client and the main client.
    // This allows us to close the protocol client independently of the main client
    // which we do when we exit out of studio in open mode.
    if (!browserCriClient.currentlyAttachedProtocolTarget) {
      browserCriClient.currentlyAttachedProtocolTarget = await browserCriClient.currentlyAttachedTarget.clone()
    }

    await options.protocolManager?.connectToBrowser(browserCriClient.currentlyAttachedProtocolTarget)
  },

  async closeProtocolConnection () {
    const browserCriClient = this._getBrowserCriClient()

    if (browserCriClient?.currentlyAttachedProtocolTarget) {
      await browserCriClient.currentlyAttachedProtocolTarget.close()
      browserCriClient.currentlyAttachedProtocolTarget = undefined
    }
  },

  async connectToNewSpec (browser: Browser, options: BrowserNewTabOpts, automation: Automation, socketServer?: CDPSocketServer) {
    debug('connecting to new chrome tab in existing instance with url and debugging port', { url: options.url })

    const browserCriClient = this._getBrowserCriClient()

    if (!browserCriClient) throw new Error('Missing browserCriClient in connectToNewSpec')

    const pageCriClient = browserCriClient.currentlyAttachedTarget

    if (!pageCriClient) throw new Error('Missing pageCriClient in connectToNewSpec')

    if (!options.url) throw new Error('Missing url in connectToNewSpec')

    await this.connectProtocolToBrowser({ protocolManager: options.protocolManager })
    await socketServer?.attachCDPClient(pageCriClient)

    await this.attachListeners(options.url, pageCriClient, automation, options, browser)
  },

  async connectToExisting (browser: Browser, options: BrowserLaunchOpts, automation: Automation, cdpSocketServer?: CDPSocketServer) {
    const port = await protocol.getRemoteDebuggingPort()

    debug('connecting to existing chrome instance with url and debugging port', { url: options.url, port })
    if (!options.onError) throw new Error('Missing onError in connectToExisting')

    browserCriClient = await BrowserCriClient.create({
      hosts: ['127.0.0.1'],
      port,
      browserName: browser.displayName,
      onAsynchronousError: options.onError,
      onReconnect,
      fullyManageTabs: false,
      onServiceWorkerClientEvent: automation.onServiceWorkerClientEvent,
    })

    if (!options.url) throw new Error('Missing url in connectToExisting')

    const pageCriClient = await browserCriClient.attachToTargetUrl(options.url)

    await cdpSocketServer?.attachCDPClient(pageCriClient)

    await this._setAutomation(pageCriClient, automation, browserCriClient.resetBrowserTargets, options)
  },

  async attachListeners (url: string, pageCriClient: CriClient, automation: Automation, options: BrowserLaunchOpts | BrowserNewTabOpts, browser: Browser) {
    const browserCriClient = this._getBrowserCriClient()

    // Handle chrome tab crashes.
    debug('attaching crash handler to target ', pageCriClient.targetId)
    pageCriClient.on('Target.targetCrashed', async (event) => {
      debug('target crashed!', event)
      if (event.targetId !== browserCriClient?.currentlyAttachedTarget?.targetId) {
        return
      }

      const err = errors.get('RENDERER_CRASHED', browser.displayName)

      await memory.endProfiling()

      if (!options.onError) {
        errors.log(err)
        throw new Error('Missing onError in attachListeners')
      }

      options.onError(err)
    })

    if (!browserCriClient) throw new Error('Missing browserCriClient in attachListeners')

    debug('attaching listeners to chrome %o', { url, options })

    const cdpAutomation = await this._setAutomation(pageCriClient, automation, browserCriClient.resetBrowserTargets, options)

    onReconnect = (client: CriClient) => {
      // if the client disconnects (e.g. due to a computer sleeping), update
      // the frame tree on reconnect in cases there were changes while
      // the client was disconnected
      // @ts-expect-error
      return cdpAutomation._updateFrameTree(client, 'onReconnect')()
    }

    await pageCriClient.send('Page.enable')

    await options['onInitializeNewBrowserTab']?.()

    await Promise.all([
      pageCriClient.send('ServiceWorker.enable'),
      options.videoApi && this._recordVideo(cdpAutomation, options.videoApi, Number(options.browser.majorVersion)),
      this._handleDownloads(pageCriClient, options.downloadsFolder, automation),
      utils.initializeCDP(pageCriClient, automation),
    ])

    await this._navigateUsingCRI(pageCriClient, url)

    await cdpAutomation._handlePausedRequests(pageCriClient)
    cdpAutomation._listenForFrameTreeChanges(pageCriClient)

    return cdpAutomation
  },

  async open (browser: Browser, url, options: BrowserLaunchOpts, automation: Automation, cdpSocketServer?: CDPSocketServer): Promise<BrowserInstance> {
    const { isTextTerminal } = options

    const userDir = utils.getProfileDir(browser, isTextTerminal)

    const [port, preferences] = await Bluebird.all([
      protocol.getRemoteDebuggingPort(),
      _getChromePreferences(userDir),
    ])

    const defaultArgs = this._getArgs(browser, options, port)

    const defaultLaunchOptions = utils.getDefaultLaunchOptions({
      preferences,
      args: defaultArgs,
    })

    const [cacheDir, launchOptions] = await Bluebird.all([
      // ensure that we have a clean cache dir
      // before launching the browser every time
      utils.ensureCleanCache(browser, isTextTerminal),
      utils.executeBeforeBrowserLaunch(browser, defaultLaunchOptions, options),
    ])

    if (launchOptions.preferences) {
      launchOptions.preferences = _mergeChromePreferences(preferences, launchOptions.preferences as ChromePreferences)
    }

    const [extDest] = await Bluebird.all([
      this._writeExtension(
        browser,
        options,
      ),
      _removeRootExtension(),
      _disableRestorePagesPrompt(userDir),
      // Chrome adds a lock file to the user data dir. If we are restarting the run and browser, we need to remove it.
      fs.unlink(path.join(userDir, 'SingletonLock')).catch(() => {}),
      _writeChromePreferences(userDir, preferences, launchOptions.preferences as ChromePreferences),
    ])
    // normalize the --load-extensions argument by
    // massaging what the user passed into our own
    const args = _normalizeArgExtensions(extDest, launchOptions.args, launchOptions.extensions, browser)

    // this overrides any previous user-data-dir args
    // by being the last one
    args.push(`--user-data-dir=${userDir}`)
    args.push(`--disk-cache-dir=${cacheDir}`)

    debug('launching in chrome with debugging port %o', { url, args, port })

    // FIRST load the blank page
    // first allows us to connect the remote interface,
    // start video recording and then
    // we will load the actual page
    const launchedBrowser = await launch(browser, 'about:blank', port, args, launchOptions.env) as unknown as BrowserInstance & { browserCriClient: BrowserCriClient}

    la(launchedBrowser, 'did not get launched browser instance')

    // SECOND connect to the Chrome remote interface
    // and when the connection is ready
    // navigate to the actual url
    if (!options.onError) throw new Error('Missing onError in chrome#open')

    browserCriClient = await BrowserCriClient.create({
      hosts: ['127.0.0.1'],
      port,
      browserName: browser.displayName,
      onAsynchronousError: options.onError,
      onReconnect,
      protocolManager: options.protocolManager,
      fullyManageTabs: true,
      onServiceWorkerClientEvent: automation.onServiceWorkerClientEvent,
    })

    la(browserCriClient, 'expected Chrome remote interface reference', browserCriClient)

    try {
      browserCriClient.ensureMinimumProtocolVersion('1.3')
    } catch (err: any) {
      // if this minimum chrome version changes, sync it with
      // packages/web-config/webpack.config.base.ts and
      // npm/webpack-batteries-included-preprocessor/index.js
      throw new Error(`Cypress requires at least Chrome 64.\n\nDetails:\n${err.message}`)
    }

    // monkey-patch the .kill method to that the CDP connection is closed
    const originalBrowserKill = launchedBrowser.kill

    launchedBrowser.browserCriClient = browserCriClient

    launchedBrowser.kill = (...args) => {
      this.clearInstanceState({ gracefulShutdown: true })

      debug('closing chrome')

      originalBrowserKill.apply(launchedBrowser, args)
    }

    const pageCriClient = await browserCriClient.attachToTargetUrl('about:blank')

    await cdpSocketServer?.attachCDPClient(pageCriClient)

    await this.attachListeners(url, pageCriClient, automation, options, browser)

    await utils.executeAfterBrowserLaunch(browser, {
      webSocketDebuggerUrl: browserCriClient.getWebSocketDebuggerUrl(),
    })

    // return the launched browser process
    // with additional method to close the remote connection
    return launchedBrowser
  },

  async closeExtraTargets () {
    return browserCriClient?.closeExtraTargets()
  },
}
