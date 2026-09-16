import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let ChoicePanel

before(async () => {
  ;({ ChoicePanel } = await import('../src/ui/ChoicePanel.tsx'))
})


test('choice 面板显示问题和两个可选按钮', () => {
  const choice = {
    prompt: '周报应该站谁？',
    options: [
      { id: 'a', label: '支持甲' },
      { id: 'b', label: '支持乙' },
    ],
  }
  const html = renderToStaticMarkup(
    createElement(ChoicePanel, {
      choice,
      left: '50%',
      top: 100,
      onPick() {},
    }),
  )

  assert.match(html, /class="settings-panel choice-panel"/)
  assert.match(html, />周报应该站谁？</)
  assert.match(html, />支持甲</)
  assert.match(html, />支持乙</)
  assert.equal((html.match(/<button/g) ?? []).length, 2)
})
