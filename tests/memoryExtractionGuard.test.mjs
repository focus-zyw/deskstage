// 记忆提取提示词守卫:第三人称陈述不得提取为用户事实(真实事故:
// 用户在单聊里粘贴"她 genuinely enjoys architecture…"的第三人称设定块,
// 被提取成「用户喜欢建筑」「用户常在 architecture studio 出现」两条错归事实)。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('记忆提取提示词必须带主语规则:第三人称陈述/罗列清单不得提取为用户事实', async () => {
  const src = await readFile(new URL('../src/engine/llmClient.ts', import.meta.url), 'utf8')
  assert.match(src, /主语是"她\/他\/某个名字"/, '提取提示词必须显式禁止第三人称主语')
  assert.match(src, /不得提取为观众事实/, '必须写明提取禁则')
  assert.match(src, /不得升格成"经常\/习惯出现"类断言/, '罗列清单不得升格成习惯断言')
})
