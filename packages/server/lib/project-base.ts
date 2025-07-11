import check from 'check-more-types'
import Debug from 'debug'
import EE from 'events'
import _ from 'lodash'
import path from 'path'
import pkg from '@packages/root'

import { Automation } from './automation'
import browsers from './browsers'
import * as config from './config'
import * as errors from './errors'
import preprocessor from './plugins/preprocessor'
import runEvents from './plugins/run_events'
import Reporter from './reporter'
import * as savedState from './saved_state'
import { SocketCt } from './socket-ct'
import { SocketE2E } from './socket-e2e'
import { ensureProp } from './util/class-helpers'
import system from './util/system'
import { BannersState, FoundBrowser, FoundSpec, OpenProjectLaunchOptions, ProtocolManagerShape, ReceivedCypressOptions, ResolvedConfigurationOptions, TestingType, VideoRecording, AutomationCommands, StudioMetricsTypes } from '@packages/types'
import { DataContext, getCtx } from '@packages/data-context'
import { createHmac } from 'crypto'
import { ServerBase } from './server-base'
import type Protocol from 'devtools-protocol'
import type { ServiceWorkerClientEvent } from '@packages/proxy/lib/http/util/service-worker-manager'
import { v4 } from 'uuid'
import { StudioLifecycleManager } from './cloud/studio/StudioLifecycleManager'
import { reportStudioError } from './cloud/api/studio/report_studio_error'
import { CloudRequest } from './cloud/api/cloud_request'
import { isRetryableError } from './cloud/network/is_retryable_error'
import { asyncRetry } from './util/async_retry'
import { getCloudMetadata } from './cloud/get_cloud_metadata'
import { telemetryManager } from './cloud/studio/telemetry/TelemetryManager'
import { INITIALIZATION_MARK_NAMES, INITIALIZATION_TELEMETRY_GROUP_NAMES } from './cloud/studio/telemetry/constants/initialization'
import { TelemetryReporter } from './cloud/studio/telemetry/TelemetryReporter'

export interface Cfg extends ReceivedCypressOptions {
  projectId?: string
  projectRoot: string
  proxyServer?: Cypress.RuntimeConfigOptions['proxyUrl']
  fileServerFolder?: Cypress.ResolvedConfigOptions['fileServerFolder']
  testingType: TestingType
  isDefaultProtocolEnabled?: boolean
  hideCommandLog?: boolean
  hideRunnerUi?: boolean
  exit?: boolean
  state?: {
    firstOpened?: number | null
    lastOpened?: number | null
    promptsShown?: object | null
    banners?: BannersState | null
  }
  e2e: Partial<Cfg>
  component: Partial<Cfg>
  additionalIgnorePattern?: string | string[]
  resolved: ResolvedConfigurationOptions
}

const localCwd = process.cwd()

const debug = Debug('cypress:server:project')
const debugVerbose = Debug('cypress-verbose:server:project')

type StartWebsocketOptions = Pick<Cfg, 'socketIoCookie' | 'namespace' | 'screenshotsFolder' | 'report' | 'reporter' | 'reporterOptions' | 'projectRoot'>

export class ProjectBase extends EE {
  // id is sha256 of projectRoot
  public id: string

  protected ctx: DataContext
  protected _cfg?: Cfg
  protected _server?: ServerBase<any>
  protected _automation?: Automation
  private _protocolManager?: ProtocolManagerShape
  private _recordTests?: any = null
  private _isServerOpen: boolean = false

  public videoRecording?: VideoRecording
  public browser: any
  public options: OpenProjectLaunchOptions
  public testingType: Cypress.TestingType
  public spec: FoundSpec | null
  public isOpen: boolean = false
  projectRoot: string

  constructor ({
    projectRoot,
    testingType,
    options = {},
  }: {
    projectRoot: string
    testingType: Cypress.TestingType
    options: OpenProjectLaunchOptions
  }) {
    super()

    if (!projectRoot) {
      throw new Error('Instantiating lib/project requires a projectRoot!')
    }

    if (!check.unemptyString(projectRoot)) {
      throw new Error(`Expected project root path, not ${projectRoot}`)
    }

    this.testingType = testingType
    this.projectRoot = path.resolve(projectRoot)
    this.spec = null
    this.browser = null
    this.id = createHmac('sha256', 'secret-key').update(projectRoot).digest('hex')
    this.ctx = getCtx()

    debug('Project created %o', {
      testingType: this.testingType,
      projectRoot: this.projectRoot,
    })

    this.options = {
      report: false,
      onFocusTests () {},
      onError (error) {
        errors.log(error)
      },
      onWarning: this.ctx.onWarning,
      ...options,
    }
  }

  protected ensureProp = ensureProp

  setOnTestsReceived (fn) {
    this._recordTests = fn
  }

  get server () {
    return this.ensureProp(this._server, 'open')
  }

  get automation () {
    return this.ensureProp(this._automation, 'open')
  }

  get cfg () {
    return this._cfg!
  }

  get state () {
    return this.cfg.state
  }

  get remoteStates () {
    return this._server?.remoteStates
  }

  async open () {
    debug('opening project instance %s', this.projectRoot)
    debug('project open options %o', this.options)

    const cfg = this.getConfig()

    process.chdir(this.projectRoot)

    this._server = new ServerBase(cfg)

    if (!cfg.isTextTerminal) {
      const studioLifecycleManager = new StudioLifecycleManager()

      studioLifecycleManager.initializeStudioManager({
        projectId: cfg.projectId,
        cloudDataSource: this.ctx.cloud,
        cfg,
        debugData: this.configDebugData,
        ctx: this.ctx,
      })
    }

    const [port, warning] = await this._server.open(cfg, {
      getCurrentBrowser: () => this.browser,
      getSpec: () => this.spec,
      onError: this.options.onError,
      onWarning: this.options.onWarning,
      shouldCorrelatePreRequests: this.shouldCorrelatePreRequests,
      testingType: this.testingType,
      SocketCtor: this.testingType === 'e2e' ? SocketE2E : SocketCt,
    })

    this.ctx.actions.servers.setAppServerPort(port)
    this._isServerOpen = true

    // if we didnt have a cfg.port
    // then get the port once we
    // open the server
    if (!cfg.port) {
      cfg.port = port

      // and set all the urls again
      _.extend(cfg, config.setUrls(cfg))
    }

    cfg.proxyServer = cfg.proxyUrl

    // store the cfg from
    // opening the server
    this._cfg = cfg

    debug('project config: %o', _.omit(cfg, 'resolved'))

    if (warning) {
      this.options.onWarning(warning)
    }

    // save the last time they opened the project
    // along with the first time they opened it
    const now = Date.now()

    const stateToSave = {
      lastOpened: now,
      lastProjectId: cfg.projectId ?? null,
    } as any

    if (!cfg.state || !cfg.state.firstOpened) {
      stateToSave.firstOpened = now
    }

    this.startWebsockets({
      onReloadBrowser: this.options.onReloadBrowser,
      onFocusTests: this.options.onFocusTests,
      onSpecChanged: this.options.onSpecChanged,
    }, {
      socketIoCookie: cfg.socketIoCookie,
      namespace: cfg.namespace,
      screenshotsFolder: cfg.screenshotsFolder,
      report: cfg.report,
      reporter: cfg.reporter,
      reporterOptions: cfg.reporterOptions,
      projectRoot: this.projectRoot,
    })

    await this.saveState(stateToSave)

    if (cfg.isTextTerminal) {
      return
    }

    if (!cfg.experimentalInteractiveRunEvents) {
      return
    }

    const sys = await system.info()
    const beforeRunDetails = {
      config: cfg,
      cypressVersion: pkg.version,
      system: _.pick(sys, 'osName', 'osVersion'),
    }

    this.isOpen = true

    return runEvents.execute('before:run', beforeRunDetails)
  }

  reset () {
    debug('resetting project instance %s', this.projectRoot)

    // if we're in studio mode, we need to close the protocol manager
    // to ensure the config is initialized properly on browser relaunch
    if (this.ctx.coreData.studioLifecycleManager) {
      this.protocolManager?.close()
      this.protocolManager = undefined
    }

    this.spec = null
    this.browser = null

    if (this._automation) {
      this._automation.reset()
    }

    if (this._server) {
      return this._server.reset()
    }

    return
  }

  __reset () {
    preprocessor.close()

    process.chdir(localCwd)
  }

  async close () {
    debug('closing project instance %s', this.projectRoot)

    this.spec = null
    this.browser = null

    if (!this._isServerOpen) {
      return
    }

    this.__reset()

    this.ctx.actions.servers.setAppServerPort(undefined)
    this.ctx.actions.servers.setAppSocketServer(undefined)

    await Promise.all([
      this.server?.close(),
    ])

    this._isServerOpen = false
    this.isOpen = false

    const config = this.getConfig()

    if (config.isTextTerminal || !config.experimentalInteractiveRunEvents) return

    return runEvents.execute('after:run')
  }

  initializeReporter ({
    report,
    reporter,
    projectRoot,
    reporterOptions,
  }: Pick<Cfg, 'report' | 'reporter' | 'projectRoot' | 'reporterOptions'>) {
    if (!report) {
      return
    }

    try {
      Reporter.loadReporter(reporter, projectRoot)
    } catch (error: any) {
      const paths = Reporter.getSearchPathsForReporter(reporter, projectRoot)

      errors.throwErr('INVALID_REPORTER_NAME', {
        paths,
        error,
        name: reporter,
      })
    }

    return Reporter.create(reporter, reporterOptions, projectRoot)
  }

  startWebsockets (options: Omit<OpenProjectLaunchOptions, 'args'>, { socketIoCookie, namespace, screenshotsFolder, report, reporter, reporterOptions, projectRoot }: StartWebsocketOptions) {
    // if we've passed down reporter
    // then record these via mocha reporter
    const reporterInstance = this.initializeReporter({
      report,
      reporter,
      reporterOptions,
      projectRoot,
    })

    const onBrowserPreRequest = async (browserPreRequest) => {
      await this.server.addBrowserPreRequest(browserPreRequest)
    }

    const onRequestEvent = <T extends keyof AutomationCommands>(eventName: T, data: AutomationCommands[T]['dataType']): Promise<AutomationCommands[T]['returnType']> => {
      this.server.emitRequestEvent(eventName, data)

      return Promise.resolve()
    }

    const onRemoveBrowserPreRequest = (requestId: string) => {
      this.server.removeBrowserPreRequest(requestId)
    }

    const onDownloadLinkClicked = (downloadUrl: string) => {
      this.server.addPendingUrlWithoutPreRequest(downloadUrl)
    }

    const onServiceWorkerRegistrationUpdated = (data: Protocol.ServiceWorker.WorkerRegistrationUpdatedEvent) => {
      this.server.updateServiceWorkerRegistrations(data)
    }

    const onServiceWorkerVersionUpdated = (data: Protocol.ServiceWorker.WorkerVersionUpdatedEvent) => {
      this.server.updateServiceWorkerVersions(data)
    }

    const onServiceWorkerClientSideRegistrationUpdated = (data: { scriptURL: string, initiatorOrigin: string }) => {
      this.server.updateServiceWorkerClientSideRegistrations(data)
    }

    const onServiceWorkerClientEvent = (event: ServiceWorkerClientEvent) => {
      this.server.handleServiceWorkerClientEvent(event)
    }

    this._automation = new Automation({
      cyNamespace: namespace,
      cookieNamespace: socketIoCookie,
      screenshotsFolder,
      onBrowserPreRequest,
      onRequestEvent,
      onRemoveBrowserPreRequest,
      onDownloadLinkClicked,
      onServiceWorkerRegistrationUpdated,
      onServiceWorkerVersionUpdated,
      onServiceWorkerClientSideRegistrationUpdated,
      onServiceWorkerClientEvent,
    })

    const ios = this.server.startWebsockets(this.automation, this.cfg, {
      onReloadBrowser: options.onReloadBrowser,
      onFocusTests: options.onFocusTests,
      onSpecChanged: options.onSpecChanged,
      onSavedStateChanged: (state: any) => this.saveState(state),
      closeExtraTargets: this.closeExtraTargets,

      onStudioInit: async () => {
        telemetryManager.mark(INITIALIZATION_MARK_NAMES.INITIALIZATION_START)

        const endTelemetry = ({ status, canAccessStudioAI }: { status: string, canAccessStudioAI: boolean }) => {
          telemetryManager.mark(INITIALIZATION_MARK_NAMES.INITIALIZATION_END)

          TelemetryReporter.getInstance().reportTelemetry(INITIALIZATION_TELEMETRY_GROUP_NAMES.INITIALIZE_STUDIO, {
            status,
            canAccessStudioAI,
          })
        }

        const cloudStudioSessionId = v4()

        try {
          const isStudioReady = this.ctx.coreData.studioLifecycleManager?.isStudioReady()

          if (!isStudioReady) {
            debug('User entered studio mode before cloud studio was initialized')
            const { cloudUrl, cloudHeaders } = await getCloudMetadata(this.ctx.cloud)

            reportStudioError({
              cloudApi: {
                cloudUrl,
                cloudHeaders,
                CloudRequest,
                isRetryableError,
                asyncRetry,
              },
              studioHash: this.id,
              projectSlug: this.cfg.projectId,
              error: new Error('User entered studio before cloud studio was initialized'),
              studioMethod: 'onStudioInit',
              studioMethodArgs: [],
            })

            endTelemetry({ status: 'studio-not-ready', canAccessStudioAI: false })

            return { canAccessStudioAI: false, cloudStudioSessionId }
          }

          const studio = await this.ctx.coreData.studioLifecycleManager?.getStudio()

          // only capture studio started event if the user is accessing legacy studio
          if (!this.ctx.coreData.studioLifecycleManager?.cloudStudioRequested) {
            try {
              studio?.captureStudioEvent({
                type: StudioMetricsTypes.STUDIO_STARTED,
                machineId: await this.ctx.coreData.machineId,
                projectId: this.cfg.projectId,
                browser: this.browser ? {
                  name: this.browser.name,
                  family: this.browser.family,
                  channel: this.browser.channel,
                  version: this.browser.version,
                } : undefined,
                cypressVersion: pkg.version,
              })
            } catch (error) {
              debug('Error capturing studio event:', error)
            }
          }

          if (this.spec && studio?.protocolManager) {
            telemetryManager.mark(INITIALIZATION_MARK_NAMES.CAN_ACCESS_STUDIO_AI_START)
            const canAccessStudioAI = await studio?.canAccessStudioAI(this.browser) ?? false

            telemetryManager.mark(INITIALIZATION_MARK_NAMES.CAN_ACCESS_STUDIO_AI_END)

            if (!canAccessStudioAI) {
              endTelemetry({ status: 'success', canAccessStudioAI })

              return { canAccessStudioAI, cloudStudioSessionId }
            }

            this.protocolManager = studio.protocolManager
            this.protocolManager.setupProtocol()
            this.protocolManager.beforeSpec({
              ...this.spec,
              instanceId: v4(),
            })

            telemetryManager.mark(INITIALIZATION_MARK_NAMES.CONNECT_PROTOCOL_TO_BROWSER_START)
            await browsers.connectProtocolToBrowser({ browser: this.browser, foundBrowsers: this.options.browsers, protocolManager: studio.protocolManager })
            telemetryManager.mark(INITIALIZATION_MARK_NAMES.CONNECT_PROTOCOL_TO_BROWSER_END)

            if (!studio.protocolManager.dbPath) {
              debug('Protocol database path is not set after initializing protocol manager')

              endTelemetry({ status: 'protocol-db-path-not-set', canAccessStudioAI: false })

              return { canAccessStudioAI: false, cloudStudioSessionId }
            }

            telemetryManager.mark(INITIALIZATION_MARK_NAMES.INITIALIZE_STUDIO_AI_START)
            await studio.initializeStudioAI({
              protocolDbPath: studio.protocolManager.dbPath,
            })

            telemetryManager.mark(INITIALIZATION_MARK_NAMES.INITIALIZE_STUDIO_AI_END)

            endTelemetry({ status: 'success', canAccessStudioAI: true })

            return { canAccessStudioAI: true, cloudStudioSessionId }
          }

          this.protocolManager = undefined

          endTelemetry({ status: 'success', canAccessStudioAI: false })

          return { canAccessStudioAI: false, cloudStudioSessionId }
        } catch (error) {
          endTelemetry({ status: 'exception', canAccessStudioAI: false })

          return { canAccessStudioAI: false, cloudStudioSessionId }
        }
      },

      onStudioDestroy: async () => {
        const isStudioReady = await this.ctx.coreData.studioLifecycleManager?.isStudioReady()

        if (!isStudioReady) {
          debug('Studio is not ready - skipping destroy')

          return
        }

        const studio = await this.ctx.coreData.studioLifecycleManager?.getStudio()

        await studio?.destroy()

        if (this.protocolManager) {
          await browsers.closeProtocolConnection({ browser: this.browser, foundBrowsers: this.options.browsers })
          this.protocolManager?.close()
          this.protocolManager = undefined
        }
      },

      onCaptureVideoFrames: (data: any) => {
        // TODO: move this to browser automation middleware
        this.emit('capture:video:frames', data)
      },

      onConnect: (id: string) => {
        debug('socket:connected')
        this.emit('socket:connected', id)
      },

      onTestsReceivedAndMaybeRecord: async (runnables: unknown[], cb: () => void) => {
        debug('received runnables %o', runnables)

        if (reporterInstance) {
          reporterInstance.setRunnables(runnables, this.getConfig())
        }

        if (this._recordTests) {
          this._protocolManager?.addRunnables(runnables)
          await this._recordTests?.(runnables, cb)

          this._recordTests = null

          return
        }

        cb()
      },

      onMocha: async (event, runnable) => {
        // bail if we dont have a
        // reporter instance
        if (!reporterInstance) {
          return
        }

        reporterInstance.emit(event, runnable)

        if (event === 'test:before:run') {
          debugVerbose('browserPreRequests prior to running %s: %O', runnable.title, this.server.getBrowserPreRequests())

          this.emit('test:before:run', {
            runnable,
            previousResults: reporterInstance?.results() || {},
          })
        } else if (event === 'end') {
          debugVerbose('browserPreRequests at the end: %O', this.server.getBrowserPreRequests())

          const [stats = {}] = await Promise.all([
            (reporterInstance != null ? reporterInstance.end() : undefined),
            this.server.end(),
          ])

          this.emit('end', stats)
        }

        return
      },
    })

    this.ctx.actions.servers.setAppSocketServer(ios)
  }

  async resetBrowserTabsForNextSpec (shouldKeepTabOpen: boolean) {
    return this.server.socket.resetBrowserTabsForNextSpec(shouldKeepTabOpen)
  }

  async resetBrowserState () {
    return this.server.socket.resetBrowserState()
  }

  closeExtraTargets () {
    return browsers.closeExtraTargets()
  }

  isRunnerSocketConnected () {
    return this.server.socket.isRunnerSocketConnected()
  }

  async sendFocusBrowserMessage () {
    if (this.browser.family === 'firefox') {
      await browsers.setFocus()
    } else {
      await this.server.sendFocusBrowserMessage()
    }
  }

  shouldCorrelatePreRequests = () => {
    return !!this.browser
  }

  setCurrentSpecAndBrowser (spec, browser: FoundBrowser) {
    this.spec = spec
    this.browser = browser

    if (this.browser.family !== 'chromium') {
      // If we're not in chromium, our strategy for correlating service worker prerequests doesn't work in non-chromium browsers (https://github.com/cypress-io/cypress/issues/28079)
      // in order to not hang for 2 seconds, we override the prerequest timeout to be 500 ms (which is what it has been historically).
      this._server?.setPreRequestTimeout(500)
    }
  }

  get protocolManager (): ProtocolManagerShape | undefined {
    return this._protocolManager
  }

  set protocolManager (protocolManager: ProtocolManagerShape | undefined) {
    this._protocolManager = protocolManager

    this._server?.setProtocolManager(protocolManager)
  }

  getAutomation () {
    return this.automation
  }

  async initializeConfig (): Promise<Cfg> {
    this.ctx.lifecycleManager.setAndLoadCurrentTestingType(this.testingType)
    let theCfg: Cfg = {
      ...(await this.ctx.lifecycleManager.getFullInitialConfig()),
      testingType: this.testingType,
    } as Cfg // ?? types are definitely wrong here I think

    if (theCfg.isTextTerminal) {
      this._cfg = theCfg

      return this._cfg
    }

    const cfgWithSaved = await this._setSavedState(theCfg)

    this._cfg = cfgWithSaved

    return this._cfg
  }

  // returns project config (user settings + defaults + cypress.config.{js,ts,mjs,cjs})
  // with additional object "state" which are transient things like
  // window width and height, DevTools open or not, etc.
  getConfig (): Cfg {
    if (!this._cfg) {
      throw Error('Must call #initializeConfig before accessing config.')
    }

    debug('project has config %o', this._cfg)

    const isDefaultProtocolEnabled = this._protocolManager?.isProtocolEnabled ?? false

    const hideRunnerUi = (
      this.options?.args?.runnerUi === false ||
      (isDefaultProtocolEnabled && this._cfg.isTextTerminal && !this.options?.args?.runnerUi)
    )

    // hide the command log if explicitly requested or if we are hiding the runner
    const hideCommandLog = this._cfg.env?.NO_COMMAND_LOG === 1 || hideRunnerUi

    return {
      ...this._cfg,
      remote: this.remoteStates?.current() ?? {} as Cypress.RemoteState,
      browser: this.browser,
      testingType: this.ctx.coreData.currentTestingType ?? 'e2e',
      specs: [],
      isDefaultProtocolEnabled,
      hideCommandLog,
      hideRunnerUi,
    }
  }

  // Saved state

  // forces saving of project's state by first merging with argument
  async saveState (stateChanges = {}) {
    if (!this.cfg) {
      throw new Error('Missing project config')
    }

    if (!this.projectRoot) {
      throw new Error('Missing project root')
    }

    let state = await savedState.create(this.projectRoot, this.cfg.isTextTerminal)

    state.set(stateChanges)
    this.cfg.state = await state.get()

    return this.cfg.state
  }

  async _setSavedState (cfg: Cfg) {
    debug('get saved state')

    const state = await savedState.create(this.projectRoot, cfg.isTextTerminal)

    cfg.state = await state.get()

    return cfg
  }

  // These methods are not related to start server/sockets/runners
  async getProjectId () {
    return getCtx().lifecycleManager.getProjectId()
  }

  get configDebugData () {
    return this.ctx.lifecycleManager.configDebugData
  }

  // For testing
  // Do not use this method outside of testing
  // pass all your options when you create a new instance!
  __setOptions (options: OpenProjectLaunchOptions) {
    this.options = options
  }

  __setConfig (cfg: Cfg) {
    this._cfg = cfg
  }
}
