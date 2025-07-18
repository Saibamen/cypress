import type Sinon from 'sinon'
import type { expect as Expect } from 'chai'
import type { KeyPressSupportedKeys } from '@packages/types'
import type { SendDebuggerCommand } from '../../../../lib/browsers/cdp_automation'
import { cdpKeyPress, bidiKeyPress, BIDI_VALUE, CDP_KEYCODE } from '../../../../lib/automation/commands/key_press'
import { Client as WebdriverClient } from 'webdriver'
import type { Protocol } from 'devtools-protocol'
const { expect, sinon }: { expect: typeof Expect, sinon: Sinon.SinonSandbox } = require('../../../spec_helper')

type ClientParams<T extends keyof WebdriverClient> = WebdriverClient[T] extends (...args: any[]) => any ?
  Parameters<WebdriverClient[T]> :
  never

type ClientReturn<T extends keyof WebdriverClient> = WebdriverClient[T] extends (...args: any[]) => any ?
  ReturnType<WebdriverClient[T]> :
  never

describe('key:press automation command', () => {
  describe('cdp', () => {
    let sendFn: Sinon.SinonStub<Parameters<SendDebuggerCommand>, ReturnType<SendDebuggerCommand>>
    const topFrameId = 'abc'
    const autFrameId = 'def'

    // @ts-expect-error
    const topExecutionContext: Protocol.Runtime.ExecutionContextDescription = {
      id: 123,
      auxData: {
        frameId: topFrameId,
      },
    }
    // @ts-expect-error
    const autExecutionContext: Protocol.Runtime.ExecutionContextDescription = {
      id: 456,
      auxData: {
        frameId: autFrameId,
      },
    }

    let executionContexts: Map<Protocol.Runtime.ExecutionContextId, Protocol.Runtime.ExecutionContextDescription> = new Map()

    const autFrame = {
      frame: {
        id: autFrameId,
        name: 'Your project',
      },
    }

    const frameTree: Protocol.Page.FrameTree = {
      // @ts-expect-error - partial mock of the frame tree
      frame: {
        id: topFrameId,
      },
      childFrames: [
        // @ts-expect-error - partial mock of the frame tree
        autFrame,
      ],
    }

    beforeEach(() => {
      sendFn = sinon.stub()
      executionContexts.set(topExecutionContext.id, topExecutionContext)
      executionContexts.set(autExecutionContext.id, autExecutionContext)
    })

    describe('when the aut frame does not have focus', () => {
      const topActiveElement: Protocol.Runtime.EvaluateResponse = {
        result: {
          type: 'object',
          description: 'a.some-link',
        },
      }

      beforeEach(() => {
        sendFn.withArgs('Runtime.evaluate', {
          expression: 'document.activeElement',
          contextId: topExecutionContext.id,
        }).resolves(topActiveElement)
      })

      it('focuses the frame and sends keydown and keyup', async () => {
        await cdpKeyPress({ key: 'Tab' }, sendFn, executionContexts, frameTree)
        expect(sendFn).to.have.been.calledWith('Runtime.evaluate', {
          expression: 'window.focus()',
          contextId: autExecutionContext.id,
        })

        expect(sendFn).to.have.been.calledWith('Input.dispatchKeyEvent', {
          type: 'keyDown',
          keyIdentifier: CDP_KEYCODE.Tab,
          key: 'Tab',
          code: 'Tab',
        })

        expect(sendFn).to.have.been.calledWith('Input.dispatchKeyEvent', {
          type: 'keyUp',
          keyIdentifier: CDP_KEYCODE.Tab,
          key: 'Tab',
          code: 'Tab',
        })
      })

      describe('when there are invalid execution contexts associated with the top frame', () => {
        // @ts-expect-error - this is a "fake" partial
        const invalidExecutionContext: Protocol.Runtime.ExecutionContextDescription = {
          id: 9,
          auxData: {
            frameId: topFrameId,
          },
        }

        beforeEach(() => {
          executionContexts = new Map()
          executionContexts.set(invalidExecutionContext.id, invalidExecutionContext)
          executionContexts.set(topExecutionContext.id, topExecutionContext)
          executionContexts.set(autExecutionContext.id, autExecutionContext)
          sendFn.withArgs('Runtime.evaluate', {
            expression: 'document.activeElement',
            contextId: invalidExecutionContext.id,
          }).rejects(new Error('Cannot find context with specified id'))
        })

        it('does not throw', async () => {
          let thrown: any = undefined

          try {
            await cdpKeyPress({ key: 'Tab' }, sendFn, executionContexts, frameTree)
          } catch (e) {
            thrown = e
          }

          expect(thrown).to.be.undefined
        })
      })
    })

    describe('when the aut frame has focus', () => {
      const topActiveElement: Protocol.Runtime.EvaluateResponse = {
        result: {
          type: 'object',
          description: autFrame.frame.name,
        },
      }

      beforeEach(() => {
        sendFn.withArgs('Runtime.evaluate', {
          expression: 'document.activeElement',
          contextId: topExecutionContext.id,
        }).resolves(topActiveElement)
      })

      it('dispaches a keydown followed by a keyup event to the provided send fn with the tab keycode', async () => {
        await cdpKeyPress({ key: 'Tab' }, sendFn, executionContexts, frameTree)

        expect(sendFn).to.have.been.calledWith('Input.dispatchKeyEvent', {
          type: 'keyDown',
          keyIdentifier: CDP_KEYCODE.Tab,
          key: 'Tab',
          code: 'Tab',
        })

        expect(sendFn).to.have.been.calledWith('Input.dispatchKeyEvent', {
          type: 'keyUp',
          keyIdentifier: CDP_KEYCODE.Tab,
          key: 'Tab',
          code: 'Tab',
        })
      })
    })

    describe('when supplied an invalid key', () => {
      it('errors', async () => {
        // typescript would keep this from happening, but it hasn't yet
        // been checked for correctness since being received by automation
        // @ts-expect-error
        await expect(cdpKeyPress({ key: 'foo' }, sendFn, executionContexts, frameTree)).to.be.rejectedWith('foo is not supported by \'cy.press()\'.')
      })
    })
  })

  describe('bidi', () => {
    let client: Sinon.SinonStubbedInstance<WebdriverClient>
    let autContext: string
    let key: KeyPressSupportedKeys
    const iframeElement = {
      'element-6066-11e4-a52e-4f735466cecf': 'uuid-1',
    }
    const otherElement = {
      'element-6066-11e4-a52e-4f735466cecf': 'uuid-2',
    }
    const topLevelContext = 'b7173d71-c76c-41ec-beff-25a72f7cae13'

    beforeEach(() => {
      // can't create a sinon stubbed instance because webdriver doesn't export the constructor. Because it's known that
      // bidiKeypress only invokes inputPerformActions, and inputPerformActions is properly typed, this is okay.
      // @ts-expect-error
      client = {
        inputPerformActions: sinon.stub<ClientParams<'inputPerformActions'>, ClientReturn<'inputPerformActions'>>(),
        getActiveElement: sinon.stub<ClientParams<'getActiveElement'>, ClientReturn<'getActiveElement'>>(),
        findElement: sinon.stub<ClientParams<'findElement'>, ClientReturn<'findElement'>>(),
        scriptEvaluate: sinon.stub<ClientParams<'scriptEvaluate'>, ClientReturn<'scriptEvaluate'>>(),
        getWindowHandle: sinon.stub<ClientParams<'getWindowHandle'>, ClientReturn<'getWindowHandle'>>(),
        switchToWindow: sinon.stub<ClientParams<'switchToWindow'>, ClientReturn<'switchToWindow'>>().resolves(),
        browsingContextGetTree: sinon.stub<ClientParams<'browsingContextGetTree'>, ClientReturn<'browsingContextGetTree'>>(),
      }

      autContext = 'someContextId'

      key = 'Tab'

      client.inputPerformActions.resolves()
      client.browsingContextGetTree.resolves({
        contexts: [
          {
            context: topLevelContext,
            children: [],
            url: 'someUrl',
            userContext: 'userContext',
          },
        ],
      })
    })

    describe('when the aut iframe is not in focus', () => {
      beforeEach(() => {
        client.getWindowHandle.resolves(topLevelContext)
        client.findElement.withArgs('css selector ', 'iframe.aut-iframe').resolves(iframeElement)
        // @ts-expect-error - webdriver types show this returning a string, but it actually returns an ElementReference, same as findElement
        client.getActiveElement.resolves(otherElement)
      })

      it('focuses the frame before dispatching keydown and keyup', async () => {
        await bidiKeyPress({ key }, client as WebdriverClient, autContext, 'idSuffix')
        expect(client.scriptEvaluate).to.have.been.calledWith({
          expression: 'window.focus()',
          target: { context: autContext },
          awaitPromise: false,
        })

        expect(client.inputPerformActions.firstCall.args[0]).to.deep.equal({
          context: autContext,
          actions: [{
            type: 'key',
            id: 'someContextId-Tab-idSuffix',
            actions: [
              { type: 'keyDown', value: BIDI_VALUE[key] },
              { type: 'keyUp', value: BIDI_VALUE[key] },
            ],
          }],
        })
      })
    })

    describe('when webdriver classic has no active window', () => {
      beforeEach(() => {
        client.getWindowHandle.rejects(new Error())
      })

      it('activates the top level context window', async () => {
        await bidiKeyPress({ key }, client as WebdriverClient, autContext, 'idSuffix')
        expect(client.switchToWindow).to.have.been.calledWith(topLevelContext)
      })
    })

    describe('when webdriver classic has the top level context as the active window', () => {
      beforeEach(() => {
        client.getWindowHandle.resolves(topLevelContext)
      })

      it('does not activate the top level context window', async () => {
        await bidiKeyPress({ key }, client as WebdriverClient, autContext, 'idSuffix')
        expect(client.switchToWindow).not.to.have.been.called
      })
    })

    describe('when webdriver classic has a different window than the top level context as the active window', () => {
      beforeEach(() => {
        client.getWindowHandle.resolves('fa54442b-bc42-45fa-9996-88b7fd066211')
      })

      it('activates the top level context window', async () => {
        await bidiKeyPress({ key }, client as WebdriverClient, autContext, 'idSuffix')
        expect(client.switchToWindow).to.have.been.calledWith(topLevelContext)
      })
    })

    it('calls client.inputPerformActions with a keydown and keyup action', async () => {
      client.getWindowHandle.resolves(topLevelContext)
      client.findElement.withArgs('css selector ', 'iframe.aut-iframe').resolves(iframeElement)
      // @ts-expect-error - webdriver types show this returning a string, but it actually returns an ElementReference, same as findElement
      client.getActiveElement.resolves(iframeElement)
      await bidiKeyPress({ key }, client as WebdriverClient, autContext, 'idSuffix')

      expect(client.inputPerformActions.firstCall.args[0]).to.deep.equal({
        context: autContext,
        actions: [{
          type: 'key',
          id: 'someContextId-Tab-idSuffix',
          actions: [
            { type: 'keyDown', value: BIDI_VALUE[key] },
            { type: 'keyUp', value: BIDI_VALUE[key] },
          ],
        }],
      })
    })
  })
})
