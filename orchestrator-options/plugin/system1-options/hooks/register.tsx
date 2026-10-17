import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Briefing, Status } from '../types'

const PANE = 'system1-options'
const CLIENT = 'orchestrator-options/client/system1_client.py'
const TEN_MINUTES = 600_000

const briefing = atom({ plugin: 'system1-options', key: 'briefing' } as const, null as Briefing | null)
const status = atom({ plugin: 'system1-options', key: 'status' } as const, { kind: 'idle' } as Status)

const fail = (stderr: string, fallback: string): Status => ({
  kind: 'error',
  message: stderr.trim().split('\n').pop() || fallback,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'system1',
      description: 'Get an xhigh executive options briefing for System 1: /system1 <task>',
    })

    return next(e)
  })

  on('command.run', { command: 'system1' }, async ($, e) => {
    const task = e.args.trim()
    if (task === '') {
      return { text: 'Usage: /system1 <task or decision to put in front of System 1>' }
    }

    await update($, status, () => ({ kind: 'thinking', task }))
    await update($, briefing, () => null)
    await $.ui.open({ id: PANE, title: 'System 1 options' })

    void $.process
      .run(['python3', CLIENT, 'options', task, '--json'], { timeoutMs: TEN_MINUTES })
      .then(async ran => {
        if (ran.exitCode !== 0) {
          await update($, status, () => fail(ran.stderr, 'client failed'))
          return
        }
        await update($, briefing, () => JSON.parse(ran.stdout) as Briefing)
        await update($, status, () => ({ kind: 'ready' }))
      })
      .catch(async err => {
        await update($, status, () => ({ kind: 'error', message: String(err) }))
      })

    return { text: 'Thinking at xhigh effort; the briefing will appear in the System 1 options pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, status)
    const current = await read($, briefing)

    const send = async (optionId: string) => {
      const b = await read($, briefing)
      if (b === null) return
      const ran = await $.process.run(
        ['python3', CLIENT, 'send', '-', '--choose', optionId],
        { stdin: JSON.stringify(b), timeoutMs: 90_000 },
      )
      await update($, status, () =>
        ran.exitCode === 0
          ? { kind: 'sent', option: optionId, reply: ran.stdout.trim().slice(0, 200) }
          : fail(ran.stderr, 'send failed'),
      )
    }

    if (state.kind === 'idle') {
      return <Text dimColor>Run /system1 &lt;task&gt; to get an options briefing.</Text>
    }
    if (state.kind === 'thinking') {
      return <Text>Thinking at xhigh effort on: {state.task}</Text>
    }
    if (state.kind === 'error') {
      return <Text color="red">System 1 client: {state.message}</Text>
    }
    if (current === null) {
      return <Text dimColor>No briefing.</Text>
    }

    return (
      <Box flexDirection="column">
        <Text bold>{current.decision}</Text>
        <Text dimColor>{current.situation}</Text>
        {current.options.map(o => (
          <Box key={o.id} flexDirection="column">
            <Text> </Text>
            <Text bold>
              [{o.id}] {o.title}
              {o.id === current.recommendation.option_id ? '  (recommended)' : ''}
            </Text>
            <Text>{o.summary}</Text>
            <Text dimColor>
              cost {o.cost} · risk {o.risk} · reversibility {o.reversibility} · {o.time_to_value}
            </Text>
            <Button key={`send-${o.id}`} label={`Send ${o.id} to System 1`} onPress={() => send(o.id)} />
          </Box>
        ))}
        <Text> </Text>
        <Text>{current.recommendation.rationale}</Text>
        {state.kind === 'sent' && (
          <Text color="green">Sent option {state.option}. System 1: {state.reply}</Text>
        )}
      </Box>
    )
  })
}
