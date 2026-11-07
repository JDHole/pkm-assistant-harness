# Scenariusze behawioralne

Runner bootuje prawdziwy plugin w tymczasowym vaulcie. Nie łączy się z Obsidianem.
`_sessionOrigin.ts` ustala agentName/sessionPath/sessionEpoch przez AgentMemory;
`_runner.ts` przekazuje tę tożsamość do runExploratoryTurn, a 51 do publicznego MCP.

2.4.7: 68–73 sprawdzają magazyn, konflikty, decyzje, restart, plan i Stop. 74 używa
produkcyjnego send_message z rzeczywistą starszą sesją i sprawdza trwałość epoki.
75 sprawdza produkcyjne składanie delegate → sub_agent task; nie wyposaża ręcznie
runnera w runtime kopii. `_drafts.ts` czyta rzeczywiste bloby i używa barier zdarzeń.
43 odracza zgodę plikową do przyjęcia; zachowuje kontrole właściciela, doręczenia
i zamrożonej autonomii operacji poza kopią. 54 zachowuje jednokrotny zapis/izolację.

Bramki: npm run typecheck, npm test, npm run selftest, npm run scenarios (65/65).
Skrypt scenarios/selftest kompiluje wyłącznie harness; nie wywołuje buildu/deployu pluginu.
