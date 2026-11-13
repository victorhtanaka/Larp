# Auditoria de segurança do Larp

**Estado:** auditoria estática e os instrumentos alcançáveis foram concluídos; resultado para produção **inconclusivo** porque controles essenciais não tiveram prova dinâmica. Nenhuma correção de controle de produção foi aplicada.

## Escopo e proveniência

- Checkout analisado: commit `af297bc4e264`; pacote `0.6.7`; data de início: 2026-11-12.
- Plataforma: Windows x64, build `10.0.26300`.
- Ferramentas observadas: Node.js `v24.15.0`, npm `11.12.1`; Electron `45.0.0`, `@supabase/supabase-js` `2.118.0`, `better-sqlite3` `13.0.3`, TypeScript `7.0.2`, Vite `8.3.5` e `tsx` `4.23.15` resolvidos no lockfile.
- Estado inicial do repositório: branch `main` no commit acima; `LARP_SECURITY_AUDIT_PLAN.md` era não rastreado e foi preservado sem edição. Nenhum arquivo de perfil/identidade real foi aberto.
- Docker daemon Linux não está acessível (`docker version` falhou ao abrir o named pipe). O laboratório Supabase local não foi iniciado; resultados SQL, HTTP, Auth e Realtime precisam permanecer **não verificados** até existir ambiente isolado. Não foram feitas alterações em projeto remoto.
- Rustup começou sem toolchains; `rust-toolchain.toml` agora fixa Rust `1.100.0`/`x86_64-pc-windows-msvc`, sem default global. Com autorização explícita, foi instalado o workload MSVC x86/x64 no Visual Studio Community `18.7.1` (toolset `14.51.36231`); Windows SDK `10.0.26100.0` já estava presente. Smoke temporário compilou/executou C++ x64 e Rust `x86_64-pc-windows-msvc` sob `vcvars64.bat`; addon napi-rs ainda não existe.
- As versões registradas são as resolvidas no lockfile, não estimativas de faixas semver. Não foram executados testes nesta fase inicial.

## Modelo de ameaças

Atacantes considerados: visitante externo sem sessão; usuário Supabase anônimo autenticado; membro malicioso de um grupo; proprietário/membro de outro grupo privado; ex-membro com JWT ou WebSocket existente; renderer comprometido; e malware/usuário local sob a mesma conta Windows. O papel Postgres `anon` não é o usuário criado por `signInAnonymously()`: esse usuário recebe papel de banco `authenticated`. Controles Electron protegem contra origens/frame não confiáveis no app cooperativo, mas não substituem autorização contra um cliente modificado que chama REST/RPC diretamente.

O host local pode ler/alterar arquivos sob a mesma conta. `safeStorage` é uma proteção de armazenamento do SO, não uma fronteira contra código malicioso já executando como o usuário. Dados de mensagens já recebidos por um membro não podem ser revogados retroativamente.

## Fluxos e fronteiras a validar

1. **Mensagem e identidade local:** renderer React → API específica `window.larp` no preload → IPC validado no processo principal → identidade Ed25519 e SQLite (`app.getPath('userData')`) → envio/recepção pela malha WebRTC e sincronização de histórico. Conteúdo e metadados controlados por pares são entrada não confiável; assinatura/autorização e persistência durável devem ser verificadas antes de exibir/confirmar.
2. **Cliente cloud modificado:** Auth anônimo → Postgres REST/RPC com papel `authenticated` → políticas RLS e funções transacionais; canais Realtime privados `group:<uuid>`; Edge Function TURN. O backend, não o IPC, deve impor isolamento, associação, concorrência e permissões contra clientes modificados. JWT/conexões já abertas após remoção exigem prova própria de revogação.
3. **Par WebRTC:** sinalização autenticada via Supabase → envelope assinado e endereçado → validação de grupo, autor/transporte, destinatário, replay e formato → canais de dados/mídia P2P. Presença e estado de mídia não são prova de autorização por si sós.
4. **Distribuição e atualização:** mantenedor → workflow de release → artefatos Squirrel e feed GitHub → updater integrado do Electron. A relação commit/tag/artefato, transporte, integridade, identidade do editor e controles operacionais dependem de evidência distinta do YAML e não serão inferidos de mocks.

## Regras de evidência e segurança do laboratório

- Usar somente dados sintéticos, identidades/chaves efêmeras e diretórios temporários. Não abrir nem imprimir `identity.json`, `supabase-session.json`, tokens, senhas, hashes/códigos de convite, credenciais TURN ou SDP/ICE completos.
- Qualquer scanner de segredos deve registrar somente caminho, categoria e localização; nunca o valor correspondente. Não ler/copiar `.temp`, `.branches`, perfis locais ou credenciais de projeto vinculadas.
- Ensaios mutantes usam exclusivamente laboratório local em loopback. Não ligar/resetar/migrar/criar branch/implantar ou escrever no Supabase remoto; não floodar serviços públicos nem consumir relay pago.
- Falta de infraestrutura não é prova de sucesso: SQL/HTTP/Realtime, multi-PC, TURN público, VM de instalação/update e limites de produção ficam explicitamente `não verificado` quando não houver prova direta.

## Resultados

Os resultados abaixo distinguem defeitos confirmados no código, riscos condicionais/hipóteses e controles sem prova. A prioridade indica ordem de remediação, não uma pontuação CVSS; as lacunas de laboratório não são classificadas como sucesso.

### Instrumentos da auditoria — 2026-11-12–13

- `npm run typecheck`: passou.
- `npm test`: 41 testes passaram, 0 falharam.
- `node_modules/.bin/tsx.cmd --test tests/security-protocol.test.ts`: 6 passaram e 1 falhou intencionalmente. O novo caso de sync usa SQLite/Ed25519 reais e reproduz a supressão de retry após uma resposta vazia `complete:true`; a falha esperada está preservada fora de `npm test`.
- `node --check tests/security-electron.cjs`: passou.
- `npm run test:supabase` com `https://example.invalid`, chave fictícia e `LARP_TEST_SUPABASE_ISOLATED=true`: rejeitou o destino por não ser loopback antes da criação de cliente. Nenhuma requisição foi enviada.
- Electron real com `LARP_SUPABASE_URL=https://example.invalid` e chave fictícia: o harness rejeitou o destino e encerrou com código não zero antes de carregar o app. Uma tentativa anterior revelou que a rejeição inicial deixava o processo Electron aberto; o harness foi corrigido e o ensaio de fail-closed terminou.
- pgTAP `supabase/tests/larp_security.test.sql` e cenário de bridge/janela real **não verificados**: Docker não está disponível, e `psql`/CLI Supabase não estão no PATH. O teste pgTAP não foi executado; também não foi criado servidor falso para substituir o laboratório.

O teste protocolar de segurança e o harness Electron permanecem fora de `npm test`; nenhum controle de produção foi alterado nesta fase.

### Snapshot remoto somente leitura — 2026-11-13

O projeto montado foi comparado ao `supabaseUrl` local sem imprimir chave e corresponde ao projeto configurado pelo Larp. Foram feitas somente consultas de inventário, catálogo, advisors e contagens agregadas; não houve escrita. `list_migrations` retorna as seis versões esperadas (`0001`–`0004`, correção de lease e perfis). O catálogo mostra seis tabelas `public.larp_*` com RLS e `FORCE RLS`; grants de `authenticated` são SELECT nas tabelas de grupos, membros, identidades e perfis, sem acesso de tabela a convites ou leases. `larp_user_profiles.user_id` não tem UPDATE para `authenticated`. Não há grants `anon` nas tabelas inspecionadas. O schema `public` concede USAGE, não CREATE, a `anon`/`authenticated`; `private` concede USAGE a `authenticated`, sem CREATE. A implantação tem trigger de limpeza de lease após remoção de membro e publica `larp_group_members` e `larp_user_profiles` no Realtime.

As 12 RPCs esperadas estão no catálogo como `SECURITY DEFINER`, proprietárias de `postgres`, com `search_path=pg_catalog, public`; execução efetiva é permitida a `authenticated` e `service_role`, não a `anon`. A ACL observada não inclui `PUBLIC`. O aviso do advisor sobre RPCs executáveis por usuários autenticados é, por si só, informativo: essa é a identidade de banco dos usuários criados por Auth anônimo; a autorização depende dos corpos das funções e precisa de prova separada. A ACL não confirma sozinha isolamento de cada RPC.

O inventário Edge Function retornou vazio: `turn-credentials` existe no checkout, mas não aparece como função implantada neste projeto. TURN relay não está disponível nesta implantação segundo o inventário; a configuração e o efeito no cliente permanecem a validar operacionalmente. O inventário de logs, limitado a contagens agregadas nas últimas 24 h, retornou 69 entradas `pgbouncer_logs` e 7 `postgres_logs`; nenhuma linha/payload de usuário foi consultada.

**Advisors de segurança** (observados em `2026-11-13T02:49:33Z`): (1) duas tabelas com RLS sem políticas — convites e leases — embora a consulta de grants não mostre acesso de tabela para `anon`/`authenticated`; manter como defesa em profundidade a revisar, não como bypass demonstrado ([RLS sem política](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)); (2) as 12 RPCs `SECURITY DEFINER` podem ser executadas por `authenticated` — avaliar corpos/identidade, sem tratar o padrão previsto de RPC como exploração ([SECURITY DEFINER](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)); (3) avisos de políticas que permitem a usuários do papel `authenticated`, incluindo usuários Auth anônimos, em grupos/membros/identidades/perfis/Realtime — esperado pelo modelo de convite, mas isolamento entre grupos continua essencial ([políticas para anônimos](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0012_auth_allow_anonymous_sign_ins)); (4) proteção contra senhas comprometidas desabilitada — controle operacional a avaliar, não usada pelo fluxo anônimo do cliente ([proteção de senha](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)).

**Advisor de performance:** três chaves estrangeiras sem índice cobrindo toda a FK: `larp_group_invites.created_by`, `larp_group_invites.group_id` e `larp_group_share_leases.holder_user_id`; validar o plano de consultas e adicionar índices se o perfil real justificar ([FKs sem índice](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)). **Advisor de saúde:** nenhuma notificação retornada.

Esses dados descrevem somente o estado observado do projeto montado. Não demonstram comportamento de Auth/RLS sob sessões adversariais, corrida de RPC, revogação Realtime em conexão aberta ou disponibilidade do relay. O inventário de migrations não prova ausência de drift no corpo das funções.

### Achados de código e riscos priorizados

| ID | Prioridade / classificação | Evidência e impacto observado |
|---|---|---|
| `LARP-SEC-01` | P1 — defeito confirmado de disponibilidade/histórico | Um membro conectado pode responder a um `sync-request` válido com lote assinado vazio e `complete:true`. `MessageSynchronizer.receiveSyncBatch` então avança `settledThrough` até `throughSequence` ( `src/renderer/rtc/message-sync.ts:458–510` ), mesmo sem cobrir o intervalo. Se a lacuna já era conhecida, `requestMissing` a considera resolvida e não reenvia o pedido. O teste isolado `tests/security-protocol.test.ts` comprova o caso: 6 testes passam e a asserção de retry falha, como esperado. Requer membro malicioso; impacto em recuperação/visibilidade do histórico, não integridade de mensagens assinadas. |
| `LARP-SEC-02` | P1 — risco de privacidade por ciclo de vida, estático | `MediaSession.selectMicrophone` e `startDisplayShare` aguardam aquisição de stream sem revalidar `closed`; `close()` não conhece o resultado ainda pendente (`src/renderer/media/session.ts:175–188,313–347,464–470`). Uma stream que resolva após fechar a sessão pode manter tracks ativos. A sequência real de captura não foi executada. |
| `LARP-SEC-03` | P1 — fronteira de consentimento condicional | O renderer escolhe fonte/áudio e solicita preparação via IPC (`src/main/ipc.ts:83–90`); o processo principal verifica fonte e token temporário por janela, mas não registra consentimento independente nem gesto confiável (`src/main/display-capture.ts:32–43`, `src/main/index.ts:114–149`). Renderer comprometido poderia invocar a ponte diretamente. Nenhum caminho de XSS remoto foi demonstrado; prompt/gesto do Electron não foi verificado em runtime. |
| `LARP-SEC-04` | P2 — defeito funcional confirmado, não exploração | `PeerMesh` produz e consome `media-state` (`src/renderer/rtc/peer-mesh.ts:207–219,545–547`), mas `signals:send` rejeita esse tipo no allowlist IPC (`src/main/ipc.ts:460–478`). Estado normal de mídia não chega aos pares pelo caminho atual. |
| `LARP-SEC-05` | P2 — corrida de ciclo de vida estática | `PeerMesh.connect()` pode continuar após `await isGroupMember`; `close()` marca fechado e fecha pares existentes, mas `ensurePeer()` não revalida o estado fechado (`src/renderer/rtc/peer-mesh.ts:186–200,290–325`). Criação tardia de conexão/recurso é possível no fluxo; impacto de rede não foi exercitado. |
| `LARP-SEC-06` | P2 — identidade de presença não confiável | A presença publica `{userId,status}` controlado pelo cliente; o parser compara chave de presença com `session.userId`, ambos fornecidos pelo próprio participante (`src/main/services/supabase-groups.ts:610–615,740–745`; `groupPresenceFromSnapshot`, linhas 36–49). Um membro pode falsificar seu estado online/away; presença não concede autorização nem prova identidade. Canal/realtime adversarial não foi exercitado. |
| `LARP-SEC-07` | P2 — hipótese de expiração sob contenção | `accept_group_invite` bloqueia grupo/convite e compara `expires_at` com `now()` (`supabase/migrations/0002_group_lifecycle.sql:63–81`). Como `now()` é estável desde o início da transação, uma chamada que começa antes do prazo e espera pelo lock pode aceitar depois do prazo. Não foi provado dinamicamente; comparar após os locks com `clock_timestamp()` e cobrir a contenção em pgTAP. |
| `LARP-SEC-08` | P2 — hipótese de inicialização concorrente | Dois processos podem carregar/criar identidade independentemente, com temporários por PID e sem single-instance lock visível (`src/main/services/identity.ts:26–75`, `src/main/index.ts:111–171`). Corrida, resultado no filesystem Windows e impacto sobre identidade não foram reproduzidos. |

**Cobertura estática sem bypass demonstrado:**

- As RPCs verificadas exigem owner/membership conforme a operação; `accept_group_invite` serializa capacidade no grupo e `leave_group` transfere ownership ou elimina grupo vazio. Share lease é chaveado por grupo, liberação exige titular, e remoção de membro limpa lease por trigger. No catálogo observado há RLS/`FORCE RLS` e sem grants diretos de tabela para `anon`/`authenticated`; execução e revogação sob concorrência continuam sem prova dinâmica.
- Perfis limitam leitura a self/grupo compartilhado e impedem UPDATE de `user_id`; validação de imagem é estrutural, não prova decodificação/dimensões. Identidade local usa armazenamento do SO e corrupção falha fechada; SQLite local não é uma fronteira contra outro processo sob a mesma conta Windows, conforme o modelo de ameaça.
- IPC valida argumentos e assinatura antes dos efeitos; a verificação de frame exige janela principal e `mainFrame`, mas não compara explicitamente origem/URL. Navegação é bloqueada no caminho observado; redirect e CSP efetiva empacotada não foram exercitados. CSP-fonte permite conexões localhost, e nenhum caminho remoto de injeção foi demonstrado.

**LARP-SEC-09 (observação operacional; não vulnerabilidade):** o avaliador da exclusão de Auth corrigiu uma hipótese anterior: `larp_group_invites.created_by` tem FK padrão `NO ACTION` (`0001_private_groups.sql:28–37`), então convites retidos bloqueiam a exclusão do usuário; se um usuário sem convites for excluído por operação externa, cascatas de membros podem deixar grupo vazio. Não há RPC/fluxo do app que exclua usuários ou convites em lote; não é um caminho de ataque confirmado.

### Riscos operacionais e cadeia de suprimentos

- **LARP-SEC-10:** `npm audit` encontrou 3 vulnerabilidades moderadas, 0 altas/críticas, todas transitivas de desenvolvimento: `glob@13.0.6` (GHSA-3g3m-2fjr-6pw4) e `minimatch@10.2.6` (GHSA-g3hv-75wg-m249), puxadas pelo ferramental Electron/Forge/asar. `fixAvailable` foi indicado; nenhuma atualização foi aplicada. A auditoria não atribuiu essas dependências ao runtime do app.
- **LARP-SEC-11:** o advisor de performance aponta FKs sem índice para `larp_group_invites.created_by`, `larp_group_invites.group_id` e `larp_group_share_leases.holder_user_id`; é risco de custo sob escala/deleções, não bypass.
- **LARP-SEC-12:** o projeto Supabase correspondente não tem Edge Functions implantadas no inventário; `turn-credentials` não está presente na implantação observada. Relay TURN fica indisponível nessa configuração, não sendo prova de credencial TURN comprometida.
- **LARP-SEC-13:** a pasta `out/` continha pacote `0.6.4`, enquanto o checkout é `0.6.7`; a varredura em memória do ASAR/unpacked não encontrou marcadores de segredos, mas não prova o pacote atual. O executável examinado não tinha assinatura Authenticode; estado de fuses não foi inspecionado. Workflow usa referências de Actions por major tag e não publica hash de artefatos; proteções do GitHub, VM de instalação/update, integridade Squirrel e origem efetiva do release não foram verificadas. Nenhum problema explorável foi demonstrado.

### Lacunas e decisão

**Decisão: inconclusiva para produção; não aprovar como auditoria de release.** Não foi confirmado achado crítico, mas faltam provas essenciais em ambiente isolado:

1. SQL/RLS/RPC sob usuários de dois grupos, visitantes e Auth anônimo; capacidade/sucessão, revogação Auth e remoção de membro com JWT/Realtime já aberto. Docker, `psql` e CLI Supabase não estão disponíveis; o pgTAP preparado não foi executado.
2. Autorização do bridge IPC testada em Electron 45 com perfil temporário: chamadas legítimas de status/identidade/assinatura/verificação/cache funcionaram; chamadas de assinatura e persistência de envelope vindas de renderer HTTP não confiável foram rejeitadas. O harness bloqueou requisições externas; backend remoto não configurado. Navegação/redirect da janela principal, captura consentida e cancelamento tardio continuam sem prova dinâmica.
3. P2P real: sync entre pares, revogação, replay/sinalização, reconexão pós-fechamento, recursos e limites com seis clientes; TURN em relay controlado.
4. VM limpa de instalação/update Squirrel, assinatura, fuses, integridade de artefatos e controles de publicação.
5. Reescrita Rust/napi-rs, migração de dados e paridade ainda não implementadas. Rust `1.100.0`, MSVC `14.51.36231` e Windows SDK `10.0.26100.0` estão disponíveis; os smoke probes passaram, mas nenhum addon/produto final foi compilado e a paridade permanece não verificada.

Nenhuma mitigação de produção foi aplicada nesta auditoria; o achado de sync permanece reproduzido e sem correção para preservar o estado observado. A remediação priorizada e seus critérios verificáveis estão em `docs/security-remediation-plan.md`.
