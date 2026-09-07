/**
 * 10_sklejone_tool_calls — PEREŁKA: sklejone tool_calls dokładnie jak bug DeepSeek Reasoner.
 *
 * Co realnie sprawdza: parser pętli (`splitConcatenatedToolCalls` + `_decomposeToolName`
 * + `_splitConcatenatedJSON`) rozkleja to, co adapter DeepSeek (akumulacja `handle_chunk`
 * zawsze na indeksie 0) zlepia w JEDNO wywołanie: nazwa „readlist", argumenty
 * '{"path":...}{"folder":...}'. Fake-serwer emituje delty tak, by wymusić tę sklejkę na
 * PRAWDZIWEJ ścieżce adaptera — deterministyczne pokrycie historycznego buga.
 *
 * Inwariant: pętla wykonała OBA narzędzia z POPRAWNYMI nazwami (tool.post ×2 ok: read + list),
 * a żadnego wywołania o nieznanej, sklejonej nazwie („readlist") NIE było.
 */
import { gluedToolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { toolPosts, assertToolOk, assert } from './_asserts.js';

export default ({
  file: '10_sklejone_tool_calls',
  name: 'sklejone tool_calls',
  opis: 'adapter zlepia read+list w „readlist" → parser rozkleja → oba narzędzia wykonane, brak nieznanej nazwy',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  livePrompt: 'W jednej turze wykonaj naraz: read Notatki/powitanie.md ORAZ list folderu Notatki.',

  offlineScript: [
    gluedToolCallTurn([
      { name: 'read', args: { path: 'Notatki/powitanie.md' } },
      { name: 'list', args: { folder: 'Notatki' } },
    ]),
    textTurn('Odczytałem notatkę i wylistowałem folder.'),
  ],

  asserts({ result, trace }) {
    // Dokładnie dwa tool.post w iteracji 0, oba OK.
    const iter0 = toolPosts(trace).filter((p) => p.i === 0);
    assert(iter0.length === 2, `Oczekiwano 2 tool.post w iter 0 (rozklejone), jest ${iter0.length}: ${JSON.stringify(iter0)}`);
    assert(iter0.every((p) => p.status === 'ok'), `Nie oba narzędzia OK: ${JSON.stringify(iter0)}`);

    // Poprawne nazwy: {read, list}; żadnej sklejki „readlist" ani innej nieznanej.
    const names = iter0.map((p) => p.tool).sort();
    assert(JSON.stringify(names) === JSON.stringify(['list', 'read']),
      `Oczekiwano narzędzi [list, read], jest [${names.join(', ')}].`);
    assert(!trace.some((e: import('./_asserts.js').TraceEvent) => e.type === 'tool.post' && e.fields.tool === 'readlist'),
      'Wystąpił tool.post o sklejonej nazwie „readlist" — parser NIE rozkleił wywołania.');

    // Wyniki obu narzędzi to sukces.
    assertToolOk(result, 'read');
    assertToolOk(result, 'list');
  },
} satisfies import('./_asserts.js').Scenario);
