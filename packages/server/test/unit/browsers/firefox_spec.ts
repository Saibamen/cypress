require('../../spec_helper')
import 'chai-as-promised'
import { expect } from 'chai'
import debug from 'debug'
import os from 'os'
import sinon from 'sinon'
import fsExtra from 'fs-extra'
import * as firefox from '../../../lib/browsers/firefox'
import firefoxUtil from '../../../lib/browsers/firefox-util'
import { CdpAutomation } from '../../../lib/browsers/cdp_automation'
import { BrowserCriClient } from '../../../lib/browsers/browser-cri-client'
import { ICriClient } from '../../../lib/browsers/cri-client'
import { type Client as WebDriverClient, default as webdriver } from 'webdriver'
import { EventEmitter } from 'stream'
import { BidiAutomation } from '../../../lib/browsers/bidi_automation'

const path = require('path')
const mockfs = require('mock-fs')
const FirefoxProfile = require('firefox-profile')
const utils = require('../../../lib/browsers/utils')
const plugins = require('../../../lib/plugins')
const specUtil = require('../../specUtils')

describe('lib/browsers/firefox', () => {
  const port = 3333
  const mockContextId = '1234-5678'
  let wdInstance: sinon.SinonStubbedInstance<WebDriverClient>
  let browserCriClient: BrowserCriClient
  let bidiAutomationClient: BidiAutomation

  afterEach(() => {
    return mockfs.restore()
  })

  beforeEach(function () {
    sinon.stub(utils, 'getProfileDir').returns('/path/to/appData/firefox-stable/interactive')

    mockfs({
      '/path/to/appData/firefox-stable/interactive': {},
    })

    wdInstance = {
      maximizeWindow: sinon.stub(),
      installAddOn: sinon.stub(),
      getWindowHandles: sinon.stub(),
      switchToWindow: sinon.stub(),
      navigateTo: sinon.stub(),
      sessionSubscribe: sinon.stub(),
      browsingContextGetTree: sinon.stub(),
      browsingContextNavigate: sinon.stub(),
      capabilities: {
        'moz:debuggerAddress': '127.0.0.1:12345',
        // @ts-expect-error
        'moz:processID': 1234,
        'wdio:driverPID': 5678,
      },
      on: sinon.stub(),
      off: sinon.stub(),
    }

    wdInstance.maximizeWindow.resolves(undefined)
    wdInstance.installAddOn.resolves(undefined)
    wdInstance.switchToWindow.resolves(undefined)
    wdInstance.navigateTo.resolves(undefined)
    wdInstance.sessionSubscribe.resolves(undefined)
    wdInstance.browsingContextNavigate.resolves(undefined)
    wdInstance.browsingContextGetTree.resolves({
      contexts: [{
        context: mockContextId,
        children: null,
        url: '',
        userContext: mockContextId,
        parent: null,
      }],
    })

    sinon.stub(webdriver, 'newSession').resolves(wdInstance)
  })

  context('#open', () => {
    beforeEach(function () {
      // majorVersion >= 86 indicates CDP support for Firefox, which provides
      // the CDP debugger URL for the after:browser:launch tests
      this.browser = { name: 'firefox', channel: 'stable', majorVersion: 100, path: '/path/to/binary' }
      this.automation = {
        use: sinon.stub().returns({}),
      }

      this.options = {
        proxyUrl: 'http://proxy-url',
        socketIoRoute: 'socket/io/route',
        browser: this.browser,
      }

      sinon.stub(process, 'pid').value(1111)

      sinon.stub(plugins, 'has')
      sinon.stub(plugins, 'execute')
      sinon.stub(utils, 'writeExtension').resolves('/path/to/ext')
      sinon.stub(utils, 'getPort').resolves(1234)
      sinon.spy(FirefoxProfile.prototype, 'setPreference')
      sinon.spy(FirefoxProfile.prototype, 'shouldDeleteOnExit')
      sinon.spy(FirefoxProfile.prototype, 'path')
      sinon.stub(FirefoxProfile.prototype, 'encoded').callsFake((cb: Function) => {
        cb(undefined, 'abcdef')
      })

      sinon.stub(fsExtra, 'writeJSON').resolves(undefined)
      sinon.stub(fsExtra, 'writeFile').returns(undefined)
      browserCriClient = sinon.createStubInstance(BrowserCriClient)

      browserCriClient.attachToTargetUrl = sinon.stub().resolves({})
      browserCriClient.getWebSocketDebuggerUrl = sinon.stub().returns('ws://debugger')
      browserCriClient.close = sinon.stub().resolves()

      sinon.stub(BrowserCriClient, 'create').resolves(browserCriClient)
      sinon.stub(CdpAutomation, 'create').resolves()

      bidiAutomationClient = sinon.createStubInstance(BidiAutomation)
      bidiAutomationClient.setTopLevelContextId = sinon.stub().returns(undefined)

      sinon.stub(BidiAutomation, 'create').returns(bidiAutomationClient)
    })

    context('#connectToNewSpec', () => {
      beforeEach(function () {
        this.options.onError = () => {}
        this.options.onInitializeNewBrowserTab = sinon.stub()
      })

      it('CDP: calls connectToNewSpecCDP in firefoxUtil', async function () {
        wdInstance.getWindowHandles.resolves(['mock-context-id'])
        await firefox.open(this.browser, 'http://', this.options, this.automation)

        this.options.url = 'next-spec-url'
        await firefox.connectToNewSpec(this.browser, this.options, this.automation)

        expect(this.options.onInitializeNewBrowserTab).to.have.been.called
        expect(wdInstance.getWindowHandles).to.have.been.called
        expect(wdInstance.switchToWindow).to.have.been.calledWith('mock-context-id')

        // first time when connecting a new tab
        expect(wdInstance.navigateTo).to.have.been.calledWith('about:blank')
        // second time when navigating to the spec
        expect(wdInstance.navigateTo).to.have.been.calledWith('next-spec-url')
      })

      it('BiDi: calls connectToNewSpecBiDi in firefoxUtil', async function () {
        this.browser.family = 'firefox'
        this.browser.majorVersion = '135'
        await firefox.open(this.browser, 'http://', this.options, this.automation)

        this.options.url = 'next-spec-url'
        await firefox.connectToNewSpec(this.browser, this.options, this.automation)

        expect(this.options.onInitializeNewBrowserTab).to.have.been.called
        expect(wdInstance.browsingContextGetTree).to.have.been.calledWith({})
        expect(bidiAutomationClient.setTopLevelContextId).to.have.been.calledWith(mockContextId)

        // Only happens one time when navigating to the spec since the context gets created on about:blank, which is tested in BidiAutomation
        expect(wdInstance.browsingContextNavigate).to.have.been.calledWith({
          context: mockContextId,
          url: 'next-spec-url',
        })

        expect(this.automation.use).to.have.been.calledWith(bidiAutomationClient.automationMiddleware)
      })
    })

    it('executes before:browser:launch if registered', async function () {
      plugins.has.withArgs('before:browser:launch').returns(true)
      plugins.execute.resolves(null)

      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(plugins.execute).to.be.calledWith('before:browser:launch')
    })

    it('does not execute before:browser:launch if not registered', async function () {
      plugins.has.withArgs('before:browser:launch').returns(false)

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(plugins.execute).not.to.be.calledWith('before:browser:launch')
    })

    it('uses default preferences if before:browser:launch returns falsy value', async function () {
      plugins.has.withArgs('before:browser:launch').returns(true)
      plugins.execute.resolves(null)

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(webdriver.newSession).to.have.been.calledWith(sinon.match({
        capabilities: {
          alwaysMatch: {
            'moz:firefoxOptions': {
              prefs: {
                'network.proxy.type': 1,
              },
            },
          },
          firstMatch: [],
        },
      }))
    })

    it('uses default preferences if before:browser:launch returns object with non-object preferences', async function () {
      plugins.has.withArgs('before:browser:launch').returns(true)
      plugins.execute.resolves({
        preferences: [],
      })

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(webdriver.newSession).to.have.been.calledWith(sinon.match({
        capabilities: {
          alwaysMatch: {
            'moz:firefoxOptions': {
              prefs: {
                'network.proxy.type': 1,
              },
            },
          },
          firstMatch: [],
        },
      }))
    })

    it('sets preferences if returned by before:browser:launch', async function () {
      plugins.has.withArgs('before:browser:launch').returns(true)
      plugins.execute.resolves({
        preferences: { 'foo': 'bar' },
      })

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(webdriver.newSession).to.have.been.calledWith(sinon.match({
        capabilities: {
          alwaysMatch: {
            'moz:firefoxOptions': {
              prefs: {
                'foo': 'bar',
              },
            },
          },
          firstMatch: [],
        },
      }))
    })

    describe(`webdriver capabilities`, () => {
      const getExpectedCapabilities = ({
        shouldUseBiDi,
        isDebugEnabled,
      }: {
        shouldUseBiDi?: boolean
        isDebugEnabled?: boolean
      } = {
        shouldUseBiDi: false,
        isDebugEnabled: false,
      }) => {
        return {
          logLevel: isDebugEnabled ? 'info' : 'silent',
          capabilities: sinon.match({
            alwaysMatch: {
              browserName: 'firefox',
              webSocketUrl: !!shouldUseBiDi,
              acceptInsecureCerts: true,
              // @see https://developer.mozilla.org/en-US/docs/Web/WebDriver/Capabilities/firefoxOptions
              'moz:firefoxOptions': {
                binary: '/path/to/binary',
                args: [
                  '-new-instance',
                  '-start-debugger-server',
                  '-no-remote',
                  ...(os.platform() !== 'linux' ? ['-foreground'] : []),
                ],
                // only partially match the preferences object because it is so large
                prefs: {
                  'remote.active-protocols': shouldUseBiDi ? 1 : 2,
                  'remote.enabled': true,
                },
              },
              'moz:debuggerAddress': !shouldUseBiDi,
              'wdio:geckodriverOptions': {
                host: '127.0.0.1',
                marionetteHost: '127.0.0.1',
                marionettePort: sinon.match(Number),
                websocketPort: sinon.match(Number),
                profileRoot: '/path/to/appData/firefox-stable/interactive',
                binaryPath: undefined,
                spawnOpts: {
                  stdio: ['ignore', 'pipe', 'pipe'],
                  env: {
                    MOZ_REMOTE_SETTINGS_DEVTOOLS: '1',
                    MOZ_HEADLESS_WIDTH: '1280',
                    MOZ_HEADLESS_HEIGHT: '720',
                  },
                },
                jsdebugger: !!isDebugEnabled,
                log: isDebugEnabled ? 'debug' : 'error',
                logNoTruncate: !!isDebugEnabled,
              },
            },
            firstMatch: [],
          }),
        }
      }

      describe(`creates the WebDriver session and geckodriver instance through capabilities, installs the extension, and passes the correct port to CDP`, function () {
        it('for CDP', async function () {
          await firefox.open(this.browser, 'http://', this.options, this.automation)
          expect(webdriver.newSession).to.have.been.calledWith((getExpectedCapabilities({ shouldUseBiDi: false })))

          expect(wdInstance.installAddOn).to.have.been.calledWith('/path/to/ext', true)

          expect(wdInstance.navigateTo).to.have.been.calledWith('http://')

          // make sure CDP gets the expected port
          expect(BrowserCriClient.create).to.be.calledWith({ hosts: ['127.0.0.1', '::1'], port: 12345, browserName: 'Firefox', onAsynchronousError: undefined, onServiceWorkerClientEvent: undefined })
        })

        it('for BiDi', async function () {
          this.browser.family = 'firefox'
          this.browser.majorVersion = '135'
          await firefox.open(this.browser, 'http://', this.options, this.automation)
          expect(webdriver.newSession).to.have.been.calledWith((getExpectedCapabilities({ shouldUseBiDi: true })))

          expect(wdInstance.installAddOn).to.have.been.calledWith('/path/to/ext', true)

          expect(wdInstance.sessionSubscribe).to.be.calledWith({ events: [
            'network.beforeRequestSent',
            'network.responseStarted',
            'network.responseCompleted',
            'network.fetchError',
            'browsingContext.contextCreated',
            'browsingContext.contextDestroyed',
          ] })

          expect(wdInstance.browsingContextGetTree).to.be.calledWith({})

          expect(wdInstance.browsingContextNavigate).to.have.been.calledWith({
            context: mockContextId,
            url: 'http://',
          })

          // make sure Bidi gets created
          expect(BidiAutomation.create).to.be.calledWith(wdInstance, this.automation)
          expect(bidiAutomationClient.setTopLevelContextId).to.be.calledWith(mockContextId)
        })
      })

      describe('debugging: sets additional arguments if "DEBUG=cypress-verbose:server:browsers:geckodriver" and "DEBUG=cypress-verbose:server:browsers:webdriver" is set', () => {
        afterEach(() => {
          debug.disable()
        })

        it('for CDP', async function () {
          debug.enable('cypress-verbose:server:browsers:geckodriver,cypress-verbose:server:browsers:webdriver')

          await firefox.open(this.browser, 'http://', this.options, this.automation)

          expect(webdriver.newSession).to.have.been.calledWith((getExpectedCapabilities({ isDebugEnabled: true })))
        })

        it('for BiDi', async function () {
          this.browser.family = 'firefox'
          this.browser.majorVersion = '135'
          debug.enable('cypress-verbose:server:browsers:geckodriver,cypress-verbose:server:browsers:webdriver')

          await firefox.open(this.browser, 'http://', this.options, this.automation)

          expect(webdriver.newSession).to.have.been.calledWith((getExpectedCapabilities({ isDebugEnabled: true, shouldUseBiDi: true })))
        })
      })
    })

    it('does not maximize the browser if headless', async function () {
      this.browser.isHeadless = true

      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(wdInstance.maximizeWindow).not.to.have.been.called
    })

    it('sets user-agent preference if specified', async function () {
      this.options.userAgent = 'User Agent'

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(webdriver.newSession).to.have.been.calledWith(sinon.match({
        capabilities: {
          alwaysMatch: {
            'moz:firefoxOptions': {
              prefs: {
                'general.useragent.override': 'User Agent',
              },
            },
          },
          firstMatch: [],
        },
      }))
    })

    it('writes extension', async function () {
      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(utils.writeExtension).to.be.calledWith(this.options.browser, this.options.isTextTerminal, this.options.proxyUrl, this.options.socketIoRoute)
    })

    it('writes extension and ensure write access', async function () {
      mockfs({
        [path.resolve(`${__dirname }../../../../../extension/dist/v2`)]: {
          'background.js': mockfs.file({
            mode: 0o444,
          }),
        },
        [`${process.env.HOME }/.config/Cypress/cy/test/browsers/firefox-stable/interactive/CypressExtension`]: {
          'background.js': mockfs.file({
            content: 'abcn',
            mode: 0o444,
          }),
        },
        [path.resolve(`${__dirname }/../../extension`)]: { 'abc': 'test' },
        '/path/to/appData/firefox-stable/interactive': {
          'xulstore.json': '[foo xulstore.json]',
          'chrome': { 'userChrome.css': '[foo userChrome.css]' },
        },
      })

      utils.writeExtension.restore()
      // @ts-expect-error
      fsExtra.writeFile.restore()
      sinon.spy(fsExtra, 'chmod')

      // bypass the extension clearing that happens in open mode, which is tested at the system test level
      this.options.isTextTerminal = true

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(fsExtra.chmod).to.have.been.calledWith(sinon.match(/CypressExtension\/background\.js/), 0o644)
    })

    it('sets proxy-related preferences if specified', async function () {
      this.options.proxyServer = 'http://proxy-server:1234'

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(webdriver.newSession).to.have.been.calledWith(sinon.match({
        capabilities: {
          alwaysMatch: {
            'moz:firefoxOptions': {
              prefs: {
                'network.proxy.http': 'proxy-server',
                'network.proxy.ssl': 'proxy-server',
                'network.proxy.http_port': 1234,
                'network.proxy.ssl_port': 1234,
                'network.proxy.no_proxies_on': '',
              },
            },
          },
          firstMatch: [],
        },
      }))
    })

    it('does not set proxy-related preferences if not specified', async function () {
      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(FirefoxProfile.prototype.setPreference).not.to.be.calledWith('network.proxy.http', 'proxy-server')
      expect(FirefoxProfile.prototype.setPreference).not.to.be.calledWith('network.proxy.https', 'proxy-server')
      expect(FirefoxProfile.prototype.setPreference).not.to.be.calledWith('network.proxy.http_port', 1234)
      expect(FirefoxProfile.prototype.setPreference).not.to.be.calledWith('network.proxy.https_port', 1234)

      expect(FirefoxProfile.prototype.setPreference).not.to.be.calledWith('network.proxy.no_proxies_on')
    })

    it('tears down the temporary profile when the browser is destroyed', async function () {
      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(FirefoxProfile.prototype.shouldDeleteOnExit).to.be.calledWith(true)
    })

    // @see https://github.com/cypress-io/cypress/issues/17896
    it('escapes the downloadsFolders path correctly when running on Windows OS', async function () {
      this.options.proxyServer = 'http://proxy-server:1234'
      this.options.downloadsFolder = 'C:/Users/test/Downloads/My_Test_Downloads_Folder'
      sinon.stub(os, 'platform').returns('win32')
      const executeBeforeBrowserLaunchSpy = sinon.spy(utils, 'executeBeforeBrowserLaunch')

      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(executeBeforeBrowserLaunchSpy).to.have.been.calledWith(this.browser, sinon.match({
        preferences: {
          // NOTE: sinon.match treats the string itself as a regular expression. The backslashes need to be escaped.
          'browser.download.dir': 'C:\\\\Users\\\\test\\\\Downloads\\\\My_Test_Downloads_Folder',
        },
      }), this.options)
    })

    describe('sets "remote.active-protocols"', function () {
      // CDP is deprecated in Firefox 129 and up.
      // In order to enable CDP, we need to set
      // remote.active-protocol=2
      // @see https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/
      // @see https://github.com/cypress-io/cypress/issues/29713
      it('=2 to enable only CDP', async function () {
        const executeBeforeBrowserLaunchSpy = sinon.spy(utils, 'executeBeforeBrowserLaunch')

        await firefox.open(this.browser, 'http://', this.options, this.automation)

        expect(executeBeforeBrowserLaunchSpy).to.have.been.calledWith(this.browser, sinon.match({
          preferences: {
            'remote.active-protocols': 2,
          },
        }), this.options)
      })

      it('=1 to enable only BiDi', async function () {
        this.browser.family = 'firefox'
        this.browser.majorVersion = '135'
        const executeBeforeBrowserLaunchSpy = sinon.spy(utils, 'executeBeforeBrowserLaunch')

        await firefox.open(this.browser, 'http://', this.options, this.automation)

        expect(executeBeforeBrowserLaunchSpy).to.have.been.calledWith(this.browser, sinon.match({
          preferences: {
            'remote.active-protocols': 1,
          },
        }), this.options)
      })
    })

    it('resolves the browser instance as an event emitter', async function () {
      const result = await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(result).to.be.an.instanceof(EventEmitter)
      expect(result.kill).to.be.an.instanceof(Function)
    })

    it('always clear user profile if it already exists', async function () {
      mockfs({
        '/path/to/appData/firefox-stable/interactive/': {
          'xulstore.json': '[foo xulstore.json]',
          'chrome': { 'userChrome.css': '[foo userChrome.css]' },
        },
      })

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(specUtil.getFsPath('/path/to/appData/firefox-stable/interactive')).to.be.undefined
    })

    it('creates xulstore.json if not exist', async function () {
      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(fsExtra.writeJSON).to.have.been.calledWith('/path/to/appData/firefox-stable/interactive/xulstore.json', {
        'chrome://browser/content/browser.xhtml':
          {
            'main-window':
              {
                'width': 1280,
                'height': 1024,
                'sizemode': 'maximized',
              },
          },

      })
    })

    it('creates chrome/userChrome.css if not exist', async function () {
      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(fsExtra.writeFile).to.have.been.calledWith('/path/to/appData/firefox-stable/interactive/chrome/userChrome.css')
    })

    it('clears browser cache', async function () {
      mockfs({
        '/path/to/appData/firefox-stable/interactive/': {
          'CypressCache': { 'foo': 'bar' },
        },
      })

      this.options.isTextTerminal = false

      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(specUtil.getFsPath('/path/to/appData/firefox-stable/interactive')).to.be.undefined
    })

    it('wraps errors when failing to connect to firefox (CDP failure)', async function () {
      const err = new Error('failed to connect to CDP')

      // BrowserCriClient.create is stubbed above. restore it and re-stub BrowserCriClient.create
      // @ts-expect-error
      BrowserCriClient.create.restore()

      sinon.stub(BrowserCriClient, 'create').rejects(err)

      await expect(firefox.open(this.browser, 'http://', this.options, this.automation)).to.be.rejectedWith()
      .then((wrapperErr) => {
        expect(wrapperErr.message).to.include('Cypress failed to make a connection to Firefox.')
        expect(wrapperErr.details).to.include(err.message)
      })
    })

    it('executes after:browser:launch if registered', async function () {
      plugins.has.withArgs('after:browser:launch').returns(true)
      plugins.execute.resolves(null)

      await firefox.open(this.browser, 'http://', this.options, this.automation)

      expect(plugins.execute).to.be.calledWith('after:browser:launch', this.browser, {
        webSocketDebuggerUrl: 'ws://debugger',
      })
    })

    it('does not execute after:browser:launch if not registered', async function () {
      plugins.has.withArgs('after:browser:launch').returns(false)

      await firefox.open(this.browser, 'http://', this.options, this.automation)
      expect(plugins.execute).not.to.be.calledWith('after:browser:launch')
    })

    context('returns BrowserInstanceWrapper as EventEmitter', function () {
      it('from browsers.launch', async function () {
        const instance = await firefox.open(this.browser, 'http://', this.options, this.automation)

        expect(instance).to.be.an.instanceof(EventEmitter)
      })

      it('kills the driver and browser PIDs when the kill method is called and emits the exit event', async function () {
        sinon.stub(process, 'kill').returns(true)
        const instance = await firefox.open(this.browser, 'http://', this.options, this.automation)

        sinon.spy(instance, 'emit')
        const killResult = instance.kill()

        expect(killResult).to.be.true
        // kills the browser
        expect(process.kill).to.have.been.calledWith(1234)
        // kills the webdriver process/ geckodriver process
        expect(process.kill).to.have.been.calledWith(5678)
        expect(browserCriClient.close).to.have.been.called
        // makes sure the exit event is called to signal to the rest of cypress server that the processes are killed
        expect(instance.emit).to.have.been.calledWith('exit')
      })

      it('swallows ESRCH in kill method if thrown', async function () {
        const ESRCHErr: Error & { code?: string } = new Error('BOOM')

        ESRCHErr.code = 'ESRCH'
        sinon.stub(process, 'kill').throws(ESRCHErr)
        const instance = await firefox.open(this.browser, 'http://', this.options, this.automation)

        sinon.spy(instance, 'emit')
        const killResult = instance.kill()

        expect(killResult).to.be.true
        // kills the browser
        expect(process.kill).to.have.been.calledWith(1234)
        // kills the webdriver process/ geckodriver process
        expect(process.kill).to.have.been.calledWith(5678)
        expect(browserCriClient.close).to.have.been.called
        // makes sure the exit event is called to signal to the rest of cypress server that the processes are killed
        expect(instance.emit).to.have.been.calledWith('exit')
      })

      it('throws CDPFailedToStartFirefox if the mox:debuggerAddress capability is not returned by webdriver', function () {
        delete wdInstance.capabilities['moz:debuggerAddress']
        sinon.stub(process, 'kill').returns(true)

        return firefox.open(this.browser, 'http://', this.options, this.automation).catch((err) => {
          // make sure we through the correct error here to prompt @packages/server/lib/modes/run.ts
          // to retry the browser connection
          expect(err.details).to.include('CDPFailedToStartFirefox: webdriver session failed to start CDP even though "moz:debuggerAddress" was provided. Please try to relaunch the browser')
          expect(err.type).to.equal('FIREFOX_COULD_NOT_CONNECT')
          // kills the browser
          expect(process.kill).to.have.been.calledWith(1234)
          // kills the webdriver process / geckodriver process
          expect(process.kill).to.have.been.calledWith(5678)
        })
      })
    })
  })

  context('#connectProtocolToBrowser', () => {
    it('throws error', () => {
      expect(firefox.connectProtocolToBrowser).to.throw('Protocol is not yet supported in firefox.')
    })
  })

  context('#closeProtocolConnection', () => {
    it('throws error', () => {
      expect(firefox.closeProtocolConnection).to.throw('Protocol is not yet supported in firefox.')
    })
  })

  context('firefox-util', () => {
    context('#setupCDP', function () {
      it('correctly sets up the remote agent', async function () {
        const criClientStub: ICriClient = {
          targetId: '',
          send: sinon.stub(),
          on: sinon.stub(),
          off: sinon.stub(),
          close: sinon.stub(),
          ws: sinon.stub() as any,
          queue: {
            enableCommands: [],
            enqueuedCommands: [],
            subscriptions: [],
          },
          closed: false,
          connected: false,
        }

        const automationStub = {
          onServiceWorkerClientEvent: sinon.stub(),
        }

        const browserCriClient: BrowserCriClient = sinon.createStubInstance(BrowserCriClient)

        browserCriClient.attachToTargetUrl = sinon.stub().resolves(criClientStub)

        sinon.stub(BrowserCriClient, 'create').resolves(browserCriClient)
        sinon.stub(CdpAutomation, 'create').resolves()

        const actual = await firefoxUtil.setupCDP(port, automationStub, null)

        expect(actual).to.equal(browserCriClient)
        expect(browserCriClient.attachToTargetUrl).to.be.calledWith('about:blank')
        expect(BrowserCriClient.create).to.be.calledWith({ hosts: ['127.0.0.1', '::1'], port, browserName: 'Firefox', onAsynchronousError: null, onServiceWorkerClientEvent: automationStub.onServiceWorkerClientEvent })
        expect(CdpAutomation.create).to.be.calledWith(
          criClientStub.send,
          criClientStub.on,
          criClientStub.off,
          browserCriClient.resetBrowserTargets,
          automationStub,
        )
      })
    })
  })
})
