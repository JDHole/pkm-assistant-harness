import test from 'ava';
import { withoutMessageTime } from './_messageTime.js';

test('usuwa tylko jedną poprawną początkową linię czasu PL lub EN', t => {
  const pl = '[czas wiadomości: 2026-11-17 11:42, poniedziałek, UTC+01:00]\n';
  const en = '[message time: 2026-11-17 10:42, Tuesday, UTC-05:30]\n';
  t.is(withoutMessageTime(pl + 'P6-A'), 'P6-A');
  t.is(withoutMessageTime(en + 'P6-A'), 'P6-A');
  t.is(withoutMessageTime(pl + en + 'P6-A'), en + 'P6-A');
  for (const input of ['P6-A', 'x\n' + pl + 'P6-A', pl.replace('UTC+', 'GMT+') + 'P6-A', pl.trimEnd()]) {
    t.is(withoutMessageTime(input), input);
  }
});
