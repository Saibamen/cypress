import _ from 'lodash'
import cs from 'classnames'
import Markdown from 'markdown-it'
import { observer } from 'mobx-react'
import React, { useCallback, useState, useEffect } from 'react'
import Tooltip from '@cypress/react-tooltip'

import appState from '../lib/app-state'
import events, { Events } from '../lib/events'
import FlashOnClick from '../lib/flash-on-click'
import StateIcon from '../lib/state-icon'
import Tag from '../lib/tag'
import type { TimeoutID } from '../lib/types'
import runnablesStore from '../runnables/runnables-store'
import type { Alias, AliasObject } from '../instruments/instrument-model'
import { determineTagType } from '../sessions/utils'

import type CommandModel from './command-model'
import type { RenderProps } from './command-model'
import TestError from '../errors/test-error'

import ChevronIcon from '@packages/frontend-shared/src/assets/icons/chevron-down-small_x8.svg'
import HiddenIcon from '@packages/frontend-shared/src/assets/icons/general-eye-closed_x16.svg'
import PinIcon from '@packages/frontend-shared/src/assets/icons/object-pin_x16.svg'
import RunningIcon from '@packages/frontend-shared/src/assets/icons/status-running_x16.svg'

const displayName = (model: CommandModel) => model.displayName || model.name
const nameClassName = (name: string) => name.replace(/(\s+)/g, '-')

const md = new Markdown()
const mdOnlyHTML = new Markdown('zero').enable(['html_inline', 'html_block'])

const asterisksRegex = /^\*\*(.+?)\*\*$/gs
// regex to match everything outside of expected/actual values like:
// 'expected **<span>** to exist in the DOM'
// `expected **glob*glob** to contain *****`
// `expected **<span>** to have CSS property **background-color** with the value **rgb(0, 0, 0)**, but the value was **rgba(0, 0, 0, 0)**`
// `expected **foo** to have length above **1** but got **0**`
// `Custom message expected **<span>** to exist in the DOM`
const assertionRegex = /^.*?expected | to[^\*]+| not[^\*]+| with[^\*]+|,? but[^\*]+/g

// used to format the display of command messages and error messages
// we use markdown syntax within our error messages (code ticks, urls, etc)
// and cy.log and Cypress.log supports markdown formatting
export const formattedMessage = (message: string, name?: string) => {
  if (!message) return ''

  // if the command has url args, don't format those chars like __ and ~~
  if (name === 'visit' || name === 'request' || name === 'origin') {
    return message
  }

  // the command message is formatted as '(Optional Custom Msg:) expected <actual> to {assertion} <expected>'
  const assertionArray = message.match(assertionRegex)

  if (name === 'assert' && assertionArray) {
    const expectedActualArray = () => {
    // get the expected and actual values of assertions
      const splitTrim = message.split(assertionRegex).filter(Boolean).map((s) => s.trim())

      // replace outside double asterisks with strong tags
      return splitTrim.map((s) => {
      // we want to escape HTML chars so that they display
      // correctly in the command log: <p> -> &lt;p&gt;
        const HTMLEscapedString = mdOnlyHTML.renderInline(s)

        return HTMLEscapedString.replace(asterisksRegex, `<strong>$1</strong>`)
      })
    }
    // for assertions print the exact text so that characters like _ and *
    // are not escaped in the assertion display when comparing values
    const result = assertionArray.flatMap((s, index) => [s, expectedActualArray()[index]])

    return result.join('')
  }

  // format markdown for everything else
  return md.renderInline(message)
}

const invisibleMessage = (model: CommandModel) => {
  return model.numElements > 1 ?
    'One or more matched elements are not visible.' :
    'This element is not visible.'
}

const numberOfChildrenMessage = (numChildren, event?: boolean) => {
  if (event) {
    return `This event occurred ${numChildren} times`
  }

  return `${numChildren} ${numChildren > 1 ? 'logs' : 'log'} currently hidden`
}

const shouldShowCount = (aliasesWithDuplicates: Array<Alias> | null, aliasName: Alias, model: CommandModel) => {
  if (model.aliasType !== 'route') {
    return false
  }

  return _.includes(aliasesWithDuplicates, aliasName)
}

interface NavColumnsProps {
  model: CommandModel
  isPinned: boolean
  toggleColumnPin: () => void
}

/**
 * NavColumns Rules:
 *   > Command Number Column
 *      - When the command is executing, it is pending and renders the pending icon
 *      - When the command is finished, it displays the command number
 *        - Commands will render a command number, where Events and System logs do not
 *      - When the command is finished and the user has pinned the log, it displays the pin icon
 *
 *   > Expander Column
 *      - When the log is a group log and it has children logs, it will display the chevron icon
 */
const NavColumns: React.FC<NavColumnsProps> = observer(({ model, isPinned, toggleColumnPin }) => (
  <>
    <div className='command-number-column' onClick={toggleColumnPin}>
      {model._isPending() && <RunningIcon data-cy="reporter-running-icon" className='fa-spin' />}
      {(!model._isPending() && isPinned) && <PinIcon className='command-pin' />}
      {(!model._isPending() && !isPinned) && model.number}
    </div>
    {model.hasChildren && !model.group && (
      <div className='command-expander-column' onClick={() => model.toggleOpen()}>
        <ChevronIcon className={cs('command-expander', { 'command-expander-is-open': model.hasChildren && !!model.isOpen })} />
      </div>
    )}
  </>
))

NavColumns.displayName = 'NavColumns'

interface AliasReferenceProps {
  aliasObj: AliasObject
  model: CommandModel
  aliasesWithDuplicates: Array<Alias> | null
}

const AliasReference: React.FC<AliasReferenceProps> = observer(({ aliasObj, model, aliasesWithDuplicates }: AliasReferenceProps) => {
  const showCount = shouldShowCount(aliasesWithDuplicates, aliasObj.name, model)
  const toolTipMessage = showCount ? `Found ${aliasObj.ordinal} alias for: '${aliasObj.name}'` : `Found an alias for: '${aliasObj.name}'`

  return (
    <Tag
      content={`@${aliasObj.name}`}
      type={model.aliasType}
      count={showCount ? aliasObj.cardinal : undefined}
      tooltipMessage={toolTipMessage}
      customClassName='command-alias'
    />
  )
})

AliasReference.displayName = 'AliasReference'

interface AliasesReferencesProps {
  model: CommandModel
  aliasesWithDuplicates: Array<Alias> | null
}

const AliasesReferences: React.FC<AliasesReferencesProps> = observer(({ model, aliasesWithDuplicates }: AliasesReferencesProps) => {
  const aliases = ([] as Array<AliasObject>).concat((model.referencesAlias as AliasObject))

  if (!aliases.length) {
    return null
  }

  return (
    <span className='command-aliases'>
      {aliases.map((aliasObj) => (
        <AliasReference
          key={aliasObj.name + aliasObj.cardinal}
          aliasObj={aliasObj}
          model={model}
          aliasesWithDuplicates={aliasesWithDuplicates}
        />
      ))}
    </span>
  )
})

AliasesReferences.displayName = 'AliasesReferences'

const Interceptions: React.FC<RenderProps> = observer(({ interceptions, wentToOrigin, status }: RenderProps) => {
  if (!interceptions?.length) {
    return null
  }

  const interceptsTitle = (
    <span>
      {wentToOrigin ? '' : <>This request did not go to origin because the response was stubbed.<br/></>}
        This request matched:
      <ul>
        {interceptions?.map(({ command, alias, type }, i) => (
          <li key={i}>
            <code>cy.{command}()</code> {type} with {alias ? <>alias <code>@{alias}</code></> : 'no alias'}
          </li>
        ))}
      </ul>
    </span>
  )

  const count = interceptions.length
  const displayAlias = interceptions[count - 1].alias

  return (
    <Tag
      content={<>
        {status && <span className='status'>{status} </span>}
        {displayAlias || <em className='no-alias'>no alias</em>}
      </>}
      count={count > 1 ? count : undefined}
      type='route'
      tooltipMessage={interceptsTitle}
      customClassName='command-interceptions'
    />
  )
})

Interceptions.displayName = 'Interceptions'
interface AliasesProps {
  model: CommandModel
}

const Aliases: React.FC<AliasesProps> = observer(({ model }: AliasesProps) => {
  if (!model.alias || model.aliasType === 'route') return null

  const aliases = ([] as Array<Alias>).concat(model.alias)

  return (
    <span>
      {aliases.map((alias) => {
        const aliases = [alias]

        if (model.hasChildren && !model.isOpen) {
          aliases.push(..._.compact(model.children.map((dupe) => dupe.alias)))
        }

        return (
          <Tag
            key={alias}
            content={aliases.join(', ')}
            type={model.aliasType}
            tooltipMessage={`${model.displayMessage} aliased as: ${aliases.map((alias) => `'${alias}'`).join(', ')}`}
            customClassName='command-alias'
          />
        )
      })}
    </span>
  )
})

Aliases.displayName = 'Aliases'

interface MessageProps {
  model: CommandModel
}

const Message: React.FC<MessageProps> = observer(({ model }: MessageProps) => (
  <span className='command-message'>
    {!!model.renderProps.indicator && (
      <i
        className={
          cs(
            model.renderProps.wentToOrigin ? 'fas' : 'far',
            'fa-circle',
            `command-message-indicator-${model.renderProps.indicator}`,
          )
        }
      />
    )}
    {!!model.displayMessage && <span
      className='command-message-text'
      dangerouslySetInnerHTML={{ __html: formattedMessage(model.displayMessage, model.name) }}
    />}
  </span>
))

Message.displayName = 'Message'

interface ProgressProps {
  model: CommandModel
}

const Progress: React.FC<ProgressProps> = observer(({ model }: ProgressProps) => {
  if (model.state !== 'pending' || !model.timeout || !model.wallClockStartedAt) {
    return null
  }

  const timeElapsed = Date.now() - new Date(model.wallClockStartedAt).getTime()
  const timeRemaining = model.timeout ? model.timeout - timeElapsed : 0
  const percentageRemaining = timeRemaining / model.timeout || 0

  // we add a key to the span to ensure a rerender and restart of the animation on change
  return (
    <div className='command-progress'>
      <span style={{ animationDuration: `${timeRemaining}ms`, transform: `scaleX(${percentageRemaining})` }} key={timeRemaining} />
    </div>
  )
})

Progress.displayName = 'Progress'

interface CommandDetailsProps {
  model: CommandModel
  groupId: number | undefined
  aliasesWithDuplicates: Array<Alias> | null
}

interface CommandControlsProps {
  model: CommandModel
  commandName: string
  events: Events
}

interface CommandProps {
  model: CommandModel
  aliasesWithDuplicates: Array<Alias> | null
  groupId?: number
  scrollIntoView: Function
}

const CommandDetails: React.FC<CommandDetailsProps> = observer(({ model, groupId, aliasesWithDuplicates }) => (
  <span className={cs('command-info')}>
    <span className={cs('command-method', { 'command-method-child': !model.hasChildren })}>
      <span>
        {model.event && model.type !== 'system' ? `(${displayName(model)})` : displayName(model)}
      </span>
    </span>
    {!!groupId && model.type === 'system' && model.state === 'failed' && <StateIcon aria-hidden className='failed-indicator' state={model.state}/>}
    {model.referencesAlias ?
      <AliasesReferences model={model} aliasesWithDuplicates={aliasesWithDuplicates} />
      : <Message model={model} />
    }
  </span>
))

CommandDetails.displayName = 'CommandDetails'

const CommandControls: React.FC<CommandControlsProps> = observer(({ model, commandName, events }) => {
  const displayNumOfElements = model.state !== 'pending' && model.numElements != null && model.numElements !== 1
  const isSystemEvent = model.type === 'system' && model.event
  const isSessionCommand = commandName === 'session'
  const displayNumOfChildren = !isSystemEvent && !isSessionCommand && model.hasChildren && !model.isOpen

  const _removeStudioCommand = useCallback((e: React.MouseEvent<HTMLElement, globalThis.MouseEvent>) => {
    e.preventDefault()
    e.stopPropagation()

    events.emit('studio:remove:command', model.number)
  }, [events, model.number])

  return (
    <span className='command-controls'>
      {model.type === 'parent' && model.isStudio && (
        <i
          className='far fa-times-circle studio-command-remove'
          onClick={_removeStudioCommand}
        />
      )}
      {isSessionCommand && (
        <Tag
          content={model.sessionInfo?.status}
          type={determineTagType(model.state)}
        />
      )}
      {!model.visible && (
        <Tooltip placement='top' title={invisibleMessage(model)} className='cy-tooltip'>
          <span>
            <HiddenIcon className='command-invisible' />
          </span>
        </Tooltip>
      )}
      {displayNumOfElements && (
        <Tag
          content={model.numElements.toString()}
          type='count'
          tooltipMessage={`${model.numElements} matched elements`}
          customClassName='num-elements'
        />
      )}
      <span className='alias-container'>
        <Interceptions {...model.renderProps} />
        <Aliases model={model} />
        {displayNumOfChildren && (
          <Tag
            content={model.numChildren}
            type='count'
            tooltipMessage={numberOfChildrenMessage(model.numChildren, model.event)}
            customClassName='num-children'
          />
        )}
      </span>
    </span>
  )
})

CommandControls.displayName = 'CommandControls'

const Command: React.FC<CommandProps> = observer(({ model, aliasesWithDuplicates, groupId, scrollIntoView }) => {
  const [showTimeout, setShowTimeout] = useState<TimeoutID | undefined>(undefined)

  useEffect(() => {
    /**
    * When moving class components into functional components (@see https://github.com/cypress-io/cypress/pull/31284),
    * we introduced a bug where the command log was not scrolling into view when a command
    * was added. This has to do with more efficient DOM rendering in React where the
    * <Attempt> component does not call useEffect when it's children update.
    *
    * To fix this, we need to call the scroll handler when a <Command> is added to the test
    *
    * @see https://github.com/cypress-io/cypress/issues/31530 for more details
    */
    scrollIntoView()
  }, [])

  if (model.group && groupId !== model.group) {
    return null
  }

  const commandName = model.name ? nameClassName(model.name) : ''
  const groupPlaceholder: Array<JSX.Element> = []

  let groupLevel = 0

  if (model.groupLevel !== undefined) {
    // cap the group nesting to 5 levels to keep the log text legible
    groupLevel = model.groupLevel < 6 ? model.groupLevel : 5

    for (let i = 1; i < groupLevel; i++) {
      groupPlaceholder.push(<span key={`${groupId}-${i}`} className='command-group-block' onClick={(e) => {
        e.stopPropagation()
        model.toggleOpen()
      }} />)
    }
  }

  const _isPinned = () => {
    return appState.pinnedSnapshotId === model.id
  }

  const _shouldShowClickMessage = () => {
    return !appState.isRunning && !!model.hasConsoleProps
  }

  const _toggleColumnPin = () => {
    if (appState.isRunning) return

    const { testId, id } = model

    if (_isPinned()) {
      appState.pinnedSnapshotId = null
      events.emit('unpin:snapshot', testId, id)
      _snapshot(true)
    } else {
      appState.pinnedSnapshotId = id as number
      events.emit('pin:snapshot', testId, id)
      events.emit('show:command', testId, id)
    }
  }

  // snapshot rules
  //
  // 1. when we hover over a command, wait 50 ms
  // if we're still hovering, send show:snapshot
  //
  // 2. when we hover off a command, wait 50 ms
  // and if we are still in a non-showing state
  // meaning we have moused over nothing instead
  // of a different command, send hide:snapshot
  //
  // this prevents heavy CPU usage when hovering
  // up and down over commands. it also prevents
  // restoring to the original through all of that.
  // additionally when quickly moving your mouse
  // over many commands, unless you're hovered for
  // 50ms, it won't show the snapshot at all. so we
  // optimize for both snapshot showing + restoring
  const _snapshot = (show: boolean) => {
    if (show) {
      runnablesStore.attemptingShowSnapshot = true

      setShowTimeout(setTimeout(() => {
        runnablesStore.showingSnapshot = true
        events.emit('show:snapshot', model.testId, model.id)
      }, 50))
    } else {
      runnablesStore.attemptingShowSnapshot = false
      clearTimeout(showTimeout as TimeoutID)

      setTimeout(() => {
        // if we are currently showing a snapshot but
        // we aren't trying to show a different snapshot
        if (runnablesStore.showingSnapshot && !runnablesStore.attemptingShowSnapshot) {
          runnablesStore.showingSnapshot = false
          events.emit('hide:snapshot', model.testId, model.id)
        }
      }, 50)
    }
  }

  return (
    <>
      <li className={cs('command', `command-name-${commandName}`, { 'command-is-studio': model.isStudio })}>
        <div
          className={cs(
            'command-wrapper',
              `command-state-${model.state}`,
              `command-type-${model.type}`,
              {
                'command-is-event': !!model.event,
                'command-is-pinned': _isPinned(),
                'command-is-interactive': (model.hasConsoleProps || model.hasSnapshot),
              },
          )}
        >
          <NavColumns model={model} isPinned={_isPinned()} toggleColumnPin={_toggleColumnPin} />
          <FlashOnClick
            message='Printed output to your console'
            onClick={_toggleColumnPin}
            shouldShowMessage={_shouldShowClickMessage}
            wrapperClassName={cs('command-pin-target', { 'command-group': !!groupId, 'command-group-no-children': !model.hasChildren && model.group })}
          >
            <div
              className={cs('command-wrapper-text', {
                'command-wrapper-text-group': model.hasChildren && groupId,
                'command-wrapper-text-group-parent': model.hasChildren && !groupId,
              })}
              onMouseEnter={() => _snapshot(true)}
              onMouseLeave={() => _snapshot(false)}
            >
              {groupPlaceholder}

              {model.hasChildren && groupId && (
                <div className={cs('command-expander-column-group', { 'nested-group-expander': model.groupLevel })} onClick={(e) => {
                  e.stopPropagation()
                  model.toggleOpen()
                }}>
                  <ChevronIcon className={cs('command-expander', { 'command-expander-is-open': model.hasChildren && !!model.isOpen })} />
                </div>
              )}
              <CommandDetails model={model} groupId={groupId} aliasesWithDuplicates={aliasesWithDuplicates} />
              <CommandControls model={model} commandName={commandName} events={events} />
            </div>
          </FlashOnClick>
        </div>
        <Progress model={model} />
        {model.hasChildren && model.isOpen && (
          <ul className='command-child-container'>
            {model.children.map((child) => (
              <Command
                key={child.id}
                model={child}
                aliasesWithDuplicates={null}
                groupId={model.id}
                scrollIntoView={scrollIntoView}
              />
            ))}
          </ul>
        )}
      </li>
      {model.showError && (
        <li>
          <TestError
            err={model.err}
            testId={model.testId}
            commandId={model.id}
            // if the err is recovered and the current command is a log group, nest the test error within the group
            groupLevel={model.group && model.hasChildren ? ++groupLevel : groupLevel}
          />
        </li>
      )}
    </>
  )
})

Command.displayName = 'Command'

export { Aliases, AliasesReferences, Message, Progress }

export default Command
