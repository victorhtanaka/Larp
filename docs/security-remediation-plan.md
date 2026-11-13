# Plano priorizado de remediação de segurança

**Escopo:** itens levantados em `docs/security-audit.md`. Este documento prioriza ações, registra critérios de aceite e evidencia os itens concluídos abaixo. A auditoria original não alterou produção; remediações posteriores são identificadas por item.

## P0 — bloqueios de decisão de release

| Ação | Dependências / fronteiras | Critério de aceite |
|---|---|---|
| Executar a matriz Auth/RLS/RPC em Supabase local isolado: visitante, usuário Auth anônimo, membro de grupo A, membro de grupo B e ex-membro; incluir acesso REST direto e RPC, capacidade/sucessão, convite/revogação, leases e remoção de membro. | Docker/CLI Supabase ou laboratório equivalente em loopback; fixture só com UUID/chaves sintéticos; migrations acumuladas e catálogo efetivo. Não usar o projeto remoto. | `supabase/tests/larp_security.test.sql` e `tests/supabase.integration.ts` passam; cada identidade só lê/muta o permitido; membro removido perde acesso em novas chamadas e a sessão/conexão antiga tem comportamento medido e documentado. Falha ou ausência do ambiente mantém release bloqueado/inconclusivo. |
| Provar a fronteira de captura no Electron Windows real, inclusive acesso direto à ponte, troca de frame/navegação, cancelamento, áudio e fechamento durante aquisição. | Harness `tests/security-electron.cjs`, `src/main/ipc.ts`, `src/main/display-capture.ts`, `src/main/index.ts`, `src/renderer/media/session.ts`; máquina/VM isolada e fonte de captura sintética ou consentida. | Chamadas sem consentimento explícito do processo principal não iniciam captura; só a janela/frame/documento autorizado recebe fonte; cancelamento/fechamento deixa zero tracks ativos. Registre também qualquer requisito legítimo de gesto/prompt do Electron. Não declarar seguro apenas por teste de ponte simulada. |
| Verificar release/atualização sem instalar sobre a estação de trabalho. | VM Windows limpa, artefato de release exato, workflow e feed Squirrel; controle de publicação GitHub. | Instalação e atualização autenticadas, origem/versão/hash do artefato correlacionados ao commit/tag, rollback/downgrade observado, assinatura e fuses inspecionados, e controles de tag/publicação registrados. Até então, integridade de distribuição permanece não verificada. |

## P1 — correções antes da próxima release

### `LARP-SEC-01` — lote sync vazio declara intervalo resolvido

- **Alvo:** `src/renderer/rtc/message-sync.ts` (`receiveSyncBatch`, `requestMissing`); teste em `tests/security-protocol.test.ts`.
- **Mudança:** não avançar `settledThrough` pelo `throughSequence` pedido só porque `complete` é verdadeiro. Validar a cobertura/continuidade das mensagens autenticadas e preservar a lacuna quando nenhum progresso foi feito; uma resposta vazia não pode suprimir nova tentativa do intervalo conhecido.
- **Compatibilidade:** manter o envelope atual; rejeitar/ignorar resposta semanticamente incompleta sem alterar assinaturas, sequência ou formato persistido.
- **Aceite:** o teste isolado atual deixa de falhar; incluir resposta vazia e parcial assinadas, resposta contínua válida, pedido pendente incompatível e recuperação posterior; `npm run typecheck`, `npm test` e a suíte de segurança isolada passam. Não inserir o caso adversarial na suíte default enquanto o plano exigir preservar falhas abertas.

### `LARP-SEC-02` — tracks podem resolver depois do fechamento da sessão

- **Alvo:** `src/renderer/media/session.ts`; testes de ciclo de vida em `tests/media-session.test.ts`.
- **Mudança:** invalidar a operação ao fechar; após cada `await` de captura, se a sessão estiver fechada, parar imediatamente todos os tracks recém-adquiridos e não publicar stream/estado. Preservar stop normal e rollback de seleção.
- **Aceite:** promises controladas resolvem depois de `close()` para microfone e compartilhamento de tela; todos os tracks terminam, nenhum callback os publica e sessões abertas continuam funcionando. Sem sleeps ou dispositivo físico obrigatório no teste determinístico.

### `LARP-SEC-03` — consentimento de captura não é autoridade independente no processo principal

- **Alvo:** `src/main/ipc.ts`, `src/main/display-capture.ts`, `src/main/index.ts`, ponte/preload e UI de captura.
- **Mudança:** tornar o processo principal dono da aprovação e do vínculo de fonte; consumir autorização uma única vez, vinculada à janela/frame/documento atual e à operação solicitada. Não aceitar a própria preparação renderer como prova de consentimento. Preservar escolha explícita legítima de tela/áudio.
- **Aceite:** renderer que chama IPC diretamente, sem ação aprovada, não obtém stream; autorização não pode ser reutilizada, transferida a outra janela nem sobreviver a navegação/fechamento. Teste adversarial Electron real cobre caminho permitido e negado. Se o Electron exigir gesto/prompt adicional, documentar e testar, não presumir.

## P2 — confiabilidade e defesa em profundidade

### `LARP-SEC-04` — `media-state` bloqueado pelo allowlist IPC

- **Alvo:** `src/main/ipc.ts` e testes da ponte/protocolo.
- **Mudança:** aceitar `media-state` com validação de envelope/campos coerente com `PeerMesh`, ou deixar de emitir o tipo se não fizer parte do produto. Não contornar o validador nem enfraquecer a lista de mensagens.
- **Aceite:** estado assinado emitido por um par atravessa IPC e chega ao consumidor do outro par; tipos e payloads inválidos continuam rejeitados.

### `LARP-SEC-05` — criação de par após fechamento de `PeerMesh`

- **Alvo:** `src/renderer/rtc/peer-mesh.ts`.
- **Mudança:** revalidar `closed` após `await isGroupMember` e no limite de `ensurePeer`; impedir que continuação assíncrona crie conexões depois de `close()`.
- **Aceite:** atrasar deterministicamente a consulta de membership, fechar a malha, resolver membership como válida e provar que nenhum peer, canal ou recurso nasce; fluxo aberto continua conectando.

### `LARP-SEC-06` — presença é dado controlado pelo cliente

- **Alvo:** `src/main/services/supabase-groups.ts`, parser de presença e apresentação.
- **Decisão:** manter presença apenas como sinal social não autoritativo, rotulada/documentada como tal; se algum controle depender dela, vinculá-la a identidade comprovada pelo servidor antes de usar. Não tratar status `online/away` como autorização ou prova de identidade.
- **Aceite:** teste de snapshot com `userId/status` falsificados não concede acesso nem altera associação de membro; UX e contrato deixam explícita a natureza advisory. Mudança para identidade server-bound requer teste de autorização no Realtime.

### `LARP-SEC-07` — expiração de convite durante espera por lock

- **Alvo:** `supabase/migrations/0002_group_lifecycle.sql` (definição original) e migration `supabase/migrations/20261113151808_fix_invite_expiry_and_fk_indexes.sql`, RPC `accept_group_invite`.
- **Mudança:** reavaliar expiração com relógio de parede após adquirir os locks necessários (por exemplo, `clock_timestamp()`); manter atomicidade e a sequência atual de locks/capacidade.
- **Aceite:** ensaio determinístico de duas sessões: uma retém o lock, outra inicia antes do prazo, a primeira libera depois do prazo, e a RPC rejeita. Acrescentar caso de convite válido e caso já expirado ao pgTAP. Nenhum teste baseado apenas em `sleep` ou relógio do cliente.

- **Status (2026-11-13):** concluído em produção pela migration `20261113151808_fix_invite_expiry_and_fk_indexes`; a expiração é reavaliada com relógio de parede após os locks.
- **Evidência:** pgTAP local passa para convite expirado e ativo; ensaio local de duas sessões confirmou que a chamada começou antes do prazo, aguardou o lock até o relógio do banco passar do prazo, rejeitou `invite unavailable` e não consumiu o convite nem criou associação.

### `LARP-SEC-08` — inicialização concorrente de identidade

- **Alvo:** inicialização em `src/main/index.ts` e `src/main/services/identity.ts`.
- **Mudança:** garantir instância única antes de abrir identidade/banco ou implementar criação/convergência atômica com lock verificável. Não sobrescrever silenciosamente identidade existente nem migrar/chmod arquivos do usuário sem backup e rollback.
- **Aceite:** dois processos concorrentes sobre diretório temporário deixam uma única identidade consistente para todos os participantes e banco íntegro; processo perdedor sai antes de abrir recursos. Testar também arquivo existente/corrompido sem abrir perfil real.

## Operação, dependências e migrações

- **LARP-SEC-09 — Auth/ownership (observação operacional):** antes de oferecer exclusão de conta, definir procedimento transacional para convites de autoria do usuário e destino de grupos/membros. A FK `created_by` atualmente pode bloquear a exclusão; não contornar removendo referências sem preservar/auditar convites e ownership. Testar grupo vazio, owner com convite retido e transferência de ownership.
- **LARP-SEC-10 — dependências:** avaliar atualização lockfile-local de `glob`/`minimatch` no ferramental Forge/asar; não usar `npm audit fix` amplo. Confirmar versões resolvidas, ausência de regressão de empacotamento e novo `npm audit --json` sem vulnerabilidades corrigíveis no grafo.
- **LARP-SEC-11 — índices:** medir planos/volume para `larp_group_invites.created_by`, `larp_group_invites.group_id` e `larp_group_share_leases.holder_user_id`; se adicionar índices, usar migration revisada, conferir lock/impacto de escrita e validar com `EXPLAIN` em dados sintéticos.

- **Status (2026-11-13):** concluído em produção pela migration `20261113151808_fix_invite_expiry_and_fk_indexes`. Antes da mudança: 2 convites e 0 leases.
- **Evidência:** `EXPLAIN` local com dados sintéticos (5.000 convites, 100 leases) usou os três índices; o advisor de produção deixou de listar FKs sem índice e agora reporta os índices como não utilizados, coerente com o volume baixo. Reavaliar uso antes de considerar remoção.
- **LARP-SEC-12 — TURN:** decidir se a implantação deve suportar relay. Se sim, implantar `turn-credentials` somente em projeto de teste controlado, configurar segredos fora do cliente e verificar autorização, validade, reutilização e revogação de credenciais; se não, documentar fallback sem relay. Não implantar no projeto remoto durante a auditoria.
- **LARP-SEC-13 — release:** pin de GitHub Actions por SHA, hash/manifesto assinado dos artefatos, política de tag/review/proteção, assinatura Authenticode e fuses explícitos; provar numa VM. A pasta `out/` atual é `0.6.4` e não satisfaz aceite do checkout `0.6.7`.

## Critério de encerramento

Marcar um item como concluído somente com diff da correção e evidência do aceite correspondente. Manter riscos dinâmicos como `não verificados` se o laboratório não estiver disponível. A reescrita Rust/napi-rs, migração de identidade/SQLite, paridade funcional e benchmark pertencem às fases seguintes de `LARP_SECURITY_AUDIT_PLAN.md`; não são substitutos para estes gates de segurança.