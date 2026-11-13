# Segurança de produção e reescrita do núcleo do Larp em Rust

## Contexto

Analisar a segurança do Larp para distribuição pública com usuários não confiáveis e vários grupos privados independentes; entregar evidências, testes e roteiro priorizado de correções. Acrescentar pesquisa comparativa de linguagens e reescrita real do núcleo em Rust, preservando React/Electron para interface e mídia, conforme escopo escolhido pelo usuário. As etapas 1–7 auditam a versão atual sem corrigi-la silenciosamente; a trilha nativa implementa a migração e valida novamente os controles, dados e desempenho. Preservar seis membros por grupo e não afirmar melhoria de performance, segurança integral ou capacidade global sem provas.

## Base confirmada na descoberta

- Aplicativo Windows/Electron com renderer React, SQLite local, identidade Ed25519, Supabase Auth/Postgres/Realtime e Edge Function TURN. `package.json` define testes locais enumerados em `npm test` e integração separada em `npm run test:supabase`.
- `src/main/index.ts:createWindow` configura sandbox, isolamento de contexto e ausência de Node no renderer; `src/main/ipc.ts:assertTrustedFrame` confere janela/frame, não a origem documental. A superfície exposta é `window.larp`, em `src/preload/index.ts` e `src/shared/contracts.ts`.
- `src/main/services/identity.ts:createIdentityManager` protege a chave privada com `safeStorage`; `src/main/services/supabase-groups.ts:createEncryptedAuthStorage` protege a sessão. O SQLite armazena envelopes de mensagens sem criptografia nesta camada. Avaliar separadamente assinatura, confidencialidade de transporte, proteção em repouso e acesso pela mesma conta Windows.
- As seis migrações implementam identidade, grupos, membros, convites, leases e perfis. Há versões substituídas de RPCs: auditar o estado cumulativo, especialmente `0002_group_lifecycle.sql` e `20261026230136_fix_screen_share_lease_timestamp.sql`.
- `tests/supabase.integration.ts` contém dois problemas instrumentais observados: `createGroup`/`invite` tratam RPCs `RETURNS TABLE` como objeto; `tableRead` consulta a coluna inexistente `id` de `larp_group_members` e aceita qualquer erro como isolamento. Não tomar resultados desse harness como prova antes de repará-lo.
- Candidatos de investigação, ainda sem exploração demonstrada: revogação com canais/peers abertos; filas e armazenamento cumulativos; privilégio de assinatura do renderer; consentimento de captura; autenticidade dos updates. `PeerMesh.sendMediaState` produz `media-state`, mas `signals:send` no IPC não o inclui na allowlist: reproduzir e avaliar impacto, não classificar automaticamente como vulnerabilidade.
- Ambiente do planejamento: Node `v24.15.0`, npm `11.12.1`; CLI Supabase e `psql` ausentes no PATH; `supabase/config.toml` ausente; `docker version` falhou porque o daemon Linux não está acessível. Não houve execução de testes, app ou consulta ao projeto remoto nesta descoberta.

## Abordagem

### 1. Fixar fronteiras, evidências e ambiente seguro

1. Criar `docs/security-audit.md`, em português, e registrar versão/commit analisado, plataforma, versões efetivamente resolvidas no lockfile, ambientes e data das provas. Descrever fluxos: conteúdo de membro → renderer → preload/IPC → identidade/SQLite/cloud; cliente modificado → Auth/REST/RPC/Realtime/TURN; pares WebRTC → sincronização/mídia; mantenedor → CI → release → updater.
2. Modelar atacante externo sem sessão, usuário de Auth anônimo autenticado, membro malicioso, proprietário de outro grupo, ex-membro com JWT/conexão ainda válidos, renderer comprometido e atacante local. Distinguir o papel Postgres `anon` do usuário criado por `signInAnonymously()`, que usa `authenticated`. Não tratar validação do Electron como autorização contra cliente modificado.
3. Trabalhar com dados sintéticos, chaves efêmeras e perfis novos. Nunca abrir arquivos reais `identity.json`/`supabase-session.json`, imprimir tokens, senhas, hashes/códigos de convite, credenciais TURN ou SDP/ICE completos. Inspeção de segredos no repositório/artefatos retorna somente caminho, categoria e localização, com valor redigido.
4. Preparar laboratório Supabase em diretório temporário fora do checkout, sem copiar `.temp`, `.branches`, configurações ou credenciais de projetos vinculados. Se houver daemon Docker utilizável, resolver a versão estável da CLI com `npm view supabase version`, registrar e usar essa versão exata via `npx --yes supabase@<versão>`. Consultar `--version` e `--help` dos subcomandos antes do uso; não instalar dependência/global no produto.
5. No laboratório, executar `supabase init`; antes de `start`, habilitar `[auth] enable_anonymous_sign_ins = true` e definir `[auth.rate_limit] anonymous_users = 200` somente no `config.toml` gerado. Registrar o limite local ampliado frente ao padrão de 30/h por IP: isto viabiliza fixtures, não prova antiabuso de produção. Se atingido, falhar a preparação, sem usar usuários simulados ou mudar limites remotos. Copiar migrações e testes SQL do checkout, preservando os nomes. Executar `supabase start` e verificar no catálogo que todas as seis migrações produziram o estado esperado. Se a CLI rejeitar os prefixos antigos, usar novo laboratório descartável com as cópias `0001`, `0002`, `0003`, `0004` prefixadas respectivamente por `20260101000001`, `20260101000002`, `20260101000003`, `20260101000004`, preservando o restante do nome. Nunca alterar migrações do produto para viabilizar o ensaio; replay sem estado íntegro bloqueia a prova SQL.
6. Capturar a saída de inicialização privadamente: os comandos podem imprimir chaves locais administrativas. Disponibilizar aos clientes apenas URL e chave pública local. Usar `http://localhost:54321` no app: `loadCloudConfiguration` não aceita HTTP em `127.0.0.1`. Não ligar, resetar, migrar, criar branch ou implantar nada remoto.
7. Se Docker continuar indisponível, continuar toda a análise estática, testes locais e inspeção operacional acessível; registrar SQL/HTTP/Realtime reais como `não verificado`. Não substituir por mocks nem transferir testes mutantes ao projeto distribuído. Infraestrutura ausente impede parecer positivo nas fronteiras não exercitadas.

As etapas 3, 4 e 5 abaixo são independentes após este inventário; podem ser analisadas em paralelo. A etapa 2 precede qualquer interpretação de resultados da integração. A consolidação depende de todas as trilhas, inclusive seus bloqueios.

### 2. Tornar os instrumentos de auditoria confiáveis

Editar somente a infraestrutura de testes nesta etapa, sem modificar `src/`, migrações de produção, parâmetros de segurança ou dependências do produto.
Os testes existentes não exercitam IPC/Electron real nem autorização e concorrência completas do backend. Os dois novos arquivos de teste e o novo pgTAP cobrem essas lacunas; ampliar o harness de integração existente em vez de criar uma segunda convenção de configuração ou RPC.



- Em `tests/supabase.integration.ts`, reaproveitar `configuration`, `rpc`, `invite`, `createGroup` e o fluxo de limpeza. Em `createGroup` e `invite`, tipar o retorno como array, exigir exatamente uma linha e ID UUID válido antes de registrá-la/retorná-la. Usar chaves Ed25519 reais em `identity`, com `generateKeyPairSync('ed25519')` e pública SPKI/PEM, formato de `createIdentityManager`.
- Corrigir `tableRead`: restringir tabela a `'larp_groups' | 'larp_group_members'`, filtrar respectivamente `id` e `group_id`; para o outsider autenticado, exigir consulta válida sem erro e resultado vazio. Erro de coluna, transporte, esquema ou autenticação não é prova de autorização. Nas tentativas que realmente esperam erro, verificar o código/condição pertinente e reler o estado com a identidade autorizada para provar ausência de alteração.
- Manter `LARP_TEST_SUPABASE_URL`, `LARP_TEST_SUPABASE_ANON_KEY`, `LARP_TEST_SUPABASE_ISOLATED=true` e as rejeições existentes de chave administrativa/origem distribuída. Para esta auditoria, acrescentar pré-condição de execução exclusivamente em loopback; variável `ISOLATED` sozinha não autoriza destino remoto. A rejeição deve ocorrer antes de criar clientes ou enviar requisições.
- Retirar a pausa/SQL Editor para expiração do harness e seus imports exclusivos. Mover essa prova para o novo `supabase/tests/larp_security.test.sql`, seguindo o teste pgTAP existente: transação, fixture própria, alteração privilegiada somente da fixture, troca explícita de role/claims, chamada real da RPC e rollback. Não esperar sete dias nem editar um convite remoto.
- Adicionar `tests/security-protocol.test.ts`, usando `node:test`, `node:assert/strict`, pares Ed25519, banco temporário e as APIs existentes `validateProtocolEnvelope`, `verifyProtocolEnvelope`, `MessageSynchronizer` e armazenamento real onde a durabilidade importa. Não criar segundo protocolo/validador de autorização.
- Criar `tests/security-electron.cjs`, harness executado pelo Electron instalado, com `node:assert/strict`. Antes de carregar `.vite/build/main.cjs`, apontar `appData` para diretório temporário, definir backend loopback e impedir conexões fora do laboratório. Isso isola o `Larp-dev` fixado pela aplicação sem mudar seu código. Observar a janela real, chamar a bridge real e criar janela estrangeira com o mesmo preload para ensaiar rejeição. Encerrar com código diferente de zero em falha e fechar os processos/recursos que o harness abriu.
- Não adicionar testes de vulnerabilidades ainda abertas à lista padrão de `npm test`. Executá-los explicitamente, com saída de falha preservada como evidência; não tornar o produto verde enfraquecendo assertions, pulando casos ou corrigindo o controle sob análise.

### 3. Provar isolamento multiusuário e transações no backend

Revisar `supabase/migrations/` em ordem, `src/main/services/supabase-groups.ts`, `src/shared/cloud-contracts.ts`, o pgTAP existente e a Edge Function. Reutilizar RPCs reais: `register_identity`, `create_group`, `list_my_groups`, `list_group_members`, `create_group_invite`, `list_group_invites`, `accept_group_invite`, `revoke_group_invite`, `remove_group_member`, `leave_group`, `acquire_group_share_lease` e `release_group_share_lease`.

**Fixture HTTP/Realtime:** U1 dono de A; U2 dono de B; U3 em A/B; U4/U5/U6 somente em A; U7 somente em B; U8 externo a A/B e dono do grupo descartável C; U9/U10 disputam a sexta vaga de A; U11 autenticado sem identidade registrada; cliente sem sessão. A começa com cinco membros `{U1,U3,U4,U5,U6}` e B com três `{U2,U3,U7}`. Gerar identidades via Auth local e dados novos por execução; restaurar/criar fixtures independentes para cenários que removem membros. Não depender de dados ou ordem de outra execução.

- Capturar catálogo do sandbox: RLS, políticas, grants efetivos/herdados de tabelas/colunas/schemas/funções, ACL `PUBLIC`, proprietários e bypass, `search_path` de `SECURITY DEFINER`, triggers, índices/constraints e publicação Realtime. Comparar com migrações e, havendo acesso seguro, com catálogo remoto somente leitura; `FORCE RLS` não prova proteção contra proprietário privilegiado/bypass.
- Exercitar tabelas e RPCs diretamente como cada atacante, sem passar pelo app. U4 não lê/administra B; U2 não administra A; U3 compartilhar perfil não cria acesso transitivo aos demais grupos. Tentar DML direto, troca de proprietário/`user_id`, inserção de associação, enumeração de convites/identidades/perfis, chamadas sem sessão e sem identidade registrada. Provar leitura positiva do dono/membro para evitar falsos negativos causados por ambiente quebrado.
- Perfis: alterar somente o próprio; rejeitar mass assignment; remover o último grupo compartilhado retira visibilidade; manter outro grupo compartilhado preserva visibilidade. Incluir cliente modificado enviando avatar textual compatível com SQL, mas WebP inválido/dimensões indevidas, para verificar a fronteira real além do validador IPC.
- Identidade: confirmar imutabilidade da chave após registro, tentativa de registrar chave alheia/sem prova de posse e impacto real nos consumidores; não chamar ausência de prova de posse de impersonação sem demonstrar o caminho.
- Convites: segredo bearer inclui o hash aceito pela RPC; verificar geração, exposição, uso único, revogação, expiração e falta de autorização. Duas aceitações do mesmo convite produzem um ingresso; dois convites com cinco membros produzem exatamente um vencedor e seis membros, sem consumir o convite perdedor. Cruzar aceitação/revogação/saída do dono com conexões independentes e barreiras, não sleeps para ordenar a corrida.
- Sucessão: saída/remoções concorrentes mantêm exatamente um dono em grupo não vazio, promovem o mais antigo com desempate por UUID e excluem o grupo vazio. Investigar exclusão de conta e referências de convites sem presumir que o fluxo operacional já existe.
- Leases: um vencedor por grupo, renovação do titular, independência A/B, liberação por terceiro sem efeito, limpeza após remoção e corrida aquisição/remoção. Expirar fixture SQL sem relógio de parede; avaliar também espera por locks atravessando expiração.
- Realtime: membro recebe/publica, outsider não entra em `group:<uuid>` privado; testar tópico inválido e canal público homônimo. Remover membro com WebSocket já aberto, token válido, refresh atrasado/falho e reconexão. Inspecionar payloads de DELETE para vazamento de metadados, não apenas a releitura posterior. Presença adulterada não pode atribuir identidade a outro membro.
- TURN: servir a função local com credenciais exclusivamente sintéticas; sem token/expirado → 401, não membro → 403, configuração ausente/inválida → 503, membro → resposta válida `no-store`, método indevido → 405. Avaliar que o segredo devolvido ao membro pode ser reutilizado fora do app e após remoção; distinguir autorização de obtenção de revogação efetiva no relay. Testar relay apenas local/descartável; não consumir quota do ExpressTURN real.

### 4. Auditar privilégios desktop, disco e captura

Seguir entradas até efeitos em `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/main/services/{identity,runtime,supabase-groups}.ts`, `src/main/{database,peer-message-store,display-capture,profile-validation}.ts`, `src/renderer/App.tsx` e `src/renderer/media/`.

- Enumerar os handlers efetivos e testar janela correta, updater, janela estrangeira, subframe e documento navegado. Rejeições precisam ocorrer antes de assinatura, leitura/escrita, RPC ou enumeração de telas. Exercitar navegação, redirects e popups na janela real; carregamento de atacante introduzido artificialmente pelo harness não prova um bypass alcançável por usuário remoto.
- Testar payloads `null`/array/campos extras, UUIDs/convites inválidos, sequências inseguras e limites N−1/N/N+1 em bytes UTF-8. Rastrear `identity:sign`: medir quais ações um renderer comprometido pode autorizar/assinar sem expor a chave privada; só confirmar cadeia XSS→privilégio se a entrada explorável for demonstrada.
- Inserir markup e URLs em mensagem, grupo, nome/perfil e título de fonte de captura; observar texto inerte, ausência de execução e tentativas de rede bloqueadas. Verificar CSP efetiva do renderer e updater no runtime/empacotado, incluindo permissões de localhost, `data:` e navegação por `file:`. Não recomendar migração de protocolo/CSP apenas por checklist sem explicar a ameaça concreta.
- Somente em perfis sintéticos: identidade/sessão truncadas, ciphertext inválido, chave pública divergente, gravação negada e inicializações concorrentes. Arquivo corrompido não pode ser silenciosamente substituído por nova identidade. Verificar ACL Windows com conta distinta, ausência de texto privado em arquivos/logs e efeito de perda/troca de sessão sobre cache; `safeStorage` não promete proteção contra malware na mesma conta.
- Cache/histórico: testar adulteração de envelope/chave, grupo/autor trocado, leitura offline e tentativa de retransmitir após remoção. Não exigir apagamento de cópias já legitimamente recebidas; isso não é revogação possível. Documentar explicitamente retenção local e acesso de novos membros a histórico pré-ingresso disponível.
- Captura real de janela sintética: fonte removida, seleção expirada de 30 s, consumo repetido, frame indevido, reload/troca de grupo/fechamento durante preparação ou retorno assíncrono de captura. Cancelar/parar/sair deve encerrar faixas, inclusive as que chegam tarde; áudio de sistema ausente por padrão e sem seleção explícita. Microfone negado não pode ser recuperado por outra janela/frame. Não capturar desktop/conversas reais.

### 5. Auditar protocolo P2P, revogação e disponibilidade

Reutilizar `src/shared/webrtc-protocol.ts`, `src/renderer/rtc/{create-peer-mesh,peer-mesh,message-sync,bridge-store,bridge-signaling}.ts`, o caminho IPC real e SQLite. Os testes existentes `tests/protocol.test.ts`, `tests/database.test.ts`, `tests/media-session.test.ts` e `tests/remote-audio-participants.test.ts` são referência, não prova de IPC, RLS ou rede real.

- Verificar bytes assinados, chave associada ao usuário/grupo, transporte versus autor, destinatário e grupo em chat/ACK/sync/SDP/ICE/estado de mídia. Preservar relay legítimo de mensagem assinada por outro autor; ACK e respostas precisam corresponder ao remetente/pedido correto. Alterar cada campo e assinatura em chaves efêmeras, com prova de que nada indevido é persistido/exibido/enviado.
- Casos de fronteira: envelope 64 KiB, chat 8 KiB, SDP 32 KiB, seis mensagens por sync, faixa 10.000, oito candidatos ICE/lote e 4 KiB/candidato; testar UTF-8 e expansão JSON. Duplicata idêntica é idempotente; conflito não sobrescreve; ACK de mensagem inexistente/autor não local não confirma entrega.
- História hostil: lote sem pedido ou de outro peer/grupo/autor, assinatura interna falsa, faixa sem progresso, sequências altas/esparsas e mesmo ID entre grupos. Validar ordenação, persistência antes de envio/ACK e falha de disco transacional sem sucesso aparente.
- Replay: `media-state` antigo após stop/reentrada, `connect-request`, ICE repetido e SDP além da janela de IDs lembrados. Reproduzir a divergência `media-state`→bridge→`signals:send`; relatar separadamente defeito funcional e consequência de segurança comprovada.
- Remover membro enquanto chat/histórico/mídia estão ativos; atrasar evento de associação, falhar releitura e trocar grupo com operações pendentes. Medir desde o commit da remoção até o último dado/mídia entregue e até fechar peer/faixas. Tentativa iniciada após confirmação local de revogação não pode ser aceita; janela anterior precisa ser quantificada e classificada, não escondida atrás de um timeout inventado.
- Ensaiar cliente modificado enviando faixas sem estado de mídia/sem lease e múltiplos streams. Determinar o que é imposto no receptor versus mera convenção do renderer cooperativo.
- Disponibilidade: mapear `waitingByAuthor`, processamento assíncrono de entrada, pedidos pendentes, listeners, validação/assinatura, consultas de associação e crescimento SQLite/WAL. Em laboratório, rajadas de 1, 10 e 50 operações/s por 10 s cada, incluindo mensagens válidas esparsas e pedidos de histórico. Estes valores são orçamento de ensaio, não SLO/capacidade de produção. Interromper cenário em 120 s, crescimento de RSS >256 MiB ou escrita de laboratório >64 MiB, registrando o limite que interrompeu a prova. Não fazer flood contra serviço público.
- Exercitar seis clientes isolados, cinco peers por cliente e 15 pares; cliente extra não entra. Executar também A/B e observar ausência de entrega cruzada. Para rede/NAT/mídia real, exigir duas identidades e dois PCs/VMs em redes apropriadas com backend HTTPS de laboratório e relay descartável; seis processos no mesmo PC não comprovam capacidade em seis PCs nem funcionamento de TURN público.

### 6. Revisar distribuição e operação de produção

- Ler `package-lock.json`, `forge.config.js`, `.github/workflows/release.yml`, `src/main/updater.ts`, `src/updater-preload.ts` e `src/updater/`. Inventariar versões reais e vulnerabilidades conhecidas de Electron/Chromium/Node, módulos nativos e dependências. Executar `npm audit --json` sem `fix`; correlacionar alertas com componente distribuído, alcance e exploração. Não atualizar lockfile nem instalar correções nesta fase.
- Inspecionar pacote gerado, ASAR/recursos e módulos desempacotados para segredos, superfícies desnecessárias, fuses e assinatura efetiva. Ausência de configuração explícita de assinatura/fuses em Forge é hipótese de hardening, não prova de aceitação de pacote adulterado. Não extrair para diretórios do usuário.
- Conferir feed HTTPS fixo, redirects, versão, integridade de `RELEASES`/`.nupkg`, identidade do editor, downgrade e erro/timeout/retry. Provas de instalação/update adulterado somente em VM com snapshot e feed/rede de laboratório; nunca instalar no host, mudar release pública ou tratar mocks de `autoUpdater` como prova criptográfica. Sem VM, relatar a fronteira dinâmica como não verificada.
- Revisar permissões mínimas CI, actions por tag versus SHA, relação commit/tag/artefato, publicação manual e possibilidade de substituir assets. Proteções de branch/tag, revisão de release, MFA e acessos administrativos dependem de evidência operacional, não são garantidas pelo YAML.
- Se o MCP Supabase estiver acessível, primeiro confirmar que a URL do projeto montado corresponde ao projeto do Larp sem imprimir credenciais. Usar apenas consultas de catálogo e configurações somente leitura; iniciar por advisors `security`, `performance`, `health` e logs agregados das últimas 24 h, sem conteúdo de usuários, tokens ou payloads. Não chamar APIs que enumerem segredos/chaves administrativas. Incluir URLs de remediação dos advisors no relatório.
- Comparar implantação com fonte: grants/RLS/funções/publicações, canais públicos desabilitados, autenticação anônima, limites de criação de contas/grupos/convites, proteção contra automação e abuso, quotas/custos de TURN/Realtime, configurações TLS/rede, segregação de ambientes, backups e recuperação comprovável, rotação/revogação de credenciais e resposta a incidente. Recursos pagos não são habilitados. Configuração não acessível é `não verificado`; não exigir email/senha/MFA do usuário do app sem relação com seu modelo anônimo, mas avaliar MFA de operadores.

### 7. Consolidar achados e roteiro de correções

Finalizar `docs/security-audit.md` com modelo de ameaças, matriz de cenários, controles observados, resultados executados e lacunas. Criar `docs/security-remediation-plan.md` com ações concretas por achado, arquivos/RPCs/configurações afetados, dependências, compatibilidade/migração quando necessária e critérios de reteste. Não implementar recomendações do relatório nesta execução.

- IDs `LARP-SEC-NNN`; para cada achado: severidade, confiança, identidade/capacidade do atacante, pré-condições, caminho arquivo/símbolo/linha ou configuração, entrada e passos, esperado/observado, impacto, prova sanitizada e correção específica. Separar `confirmado`, `hipótese a validar`, `risco residual do modelo` e `controle operacional não verificado`.
- Severidade por impacto e explorabilidade: crítica para execução arbitrária/comprometimento amplo comprovado; alta para acesso entre grupos, tomada de identidade ou captura indevida comprovados; média para abuso/negação de serviço/privacidade com impacto delimitado; baixa para endurecimento de impacto menor. Explicar pré-condições e alcance; CVE ou ausência de flag não basta.
- Prioridade P0: bloqueios críticos/altos e provas faltantes nas fronteiras essenciais; P1: demais falhas exploráveis de abuso/disponibilidade/privacidade; P2: hardening de menor impacto. Ordem de correção segue dependências reais; cada item tem teste de aceite reproduzível, sem uma lista genérica de produtos a instalar.
- Parecer `não pronto` se houver falha crítica/alta aberta; `inconclusivo para produção` se faltarem provas essenciais de isolamento, autorização/revogação, IPC, captura consentida ou confiança de distribuição. Somente emitir `apto no escopo e ambiente avaliados` sem esses bloqueios e com riscos residuais explícitos. Auditoria sem achados não é garantia de ausência de falhas.

## Extensão: pesquisa e reescrita do núcleo nativo

O usuário acrescentou reescrita para melhorar desempenho e segurança e escolheu preservar React/Electron para interface, WebRTC e mídia, substituindo o núcleo privilegiado por Rust. Não remover Electron nem prometer redução importante da RAM total: renderer, codecs e engine continuam presentes. A auditoria permanece anterior à migração; seus resultados serão critérios de aceite da reescrita.

### Pesquisa e decisão de linguagem

| Opção | Encaixe neste projeto | Decisão |
|---|---|---|
| Rust + Node-API/napi-rs | Código nativo sem GC próprio, ownership/concurrency verificadas pelo compilador, integração com o runtime existente; introduz FFI/dependências nativas que precisam de auditoria | Selecionada para domínio/persistência/criptografia; ganhos dependem de medição |
| C#/.NET | Forte integração Windows e gerenciamento automático de memória; manter Electron adicionaria CLR/bridge, substituir UI/mídia excederia o escopo escolhido | Não selecionar para esta reescrita |
| Go | Concorrência e GC gerenciado documentados; adiciona runtime/GC ao núcleo e não substitui as APIs Electron/WebRTC | Não selecionar para esta reescrita |
| TypeScript atual | Evita custo da migração; já usa criptografia e SQLite nativos. Continua na UI, protocolo web compartilhado e adaptadores do host | Referência funcional e de benchmark; não inventar que TS era memória-inseguro |

Usar Rust para o núcleo, não “converter tudo”: React, Chromium/WebRTC, captura Electron, roteamento de dispositivos e Squirrel permanecem. Preservar `@supabase/supabase-js` como transporte oficial e `safeStorage` como adaptador da proteção do SO, sem reimplementar WebSockets de Supabase nem ciphertext interno de Chromium. Rust recebe/valida dados e executa os controles de domínio/persistência; RLS e transações remotas continuam sendo a fronteira contra clientes modificados.

Selecionar addon Node-API com napi-rs 3 carregado apenas no processo principal; não sidecar, localhost HTTP, WASM nem novo runtime Tauri. Isto evita processo/protocolo extra e preserva mídia/atualizações, mas não cria isolamento de processo para Rust nem reduz o custo base do Electron. APIs V8/Node C++ privadas ficam proibidas. O addon deve ser testado no Electron 45 real, não só no Node usado para compilar.

Tauri/WebView2 não foi selecionado: documentação comprova WebView2 e controles de captura, mas não equivalência ao seletor próprio de tela/janela mais áudio de sistema do Larp. Mudar também mídia exigiria captura Windows/WASAPI e engine WebRTC separada; não trocar isso nesta execução nem transformar Rust em promessa de correção automática de RLS, XSS ou falhas lógicas.

Pesquisa de integração confirmou dois cuidados: a memory cage do Electron impede tratar buffers externos Rust→JS como zero-copy; dados mutáveis vindos de JS precisam de ownership/cópia controlada antes de trabalho assíncrono. Node-API não garante ABI das demais bibliotecas nativas. Usar filas limitadas e operações de alto nível em vez de uma chamada FFI por linha/coluna; não desativar a memory cage para obter benchmark melhor.

Ferramentas observadas: existem shims rustup, mas nenhuma toolchain está instalada/configurada; `rustc`/`cargo` falham por isso. Busca nos diretórios padrão não encontrou `vcvars64.bat`; disponibilidade real de MSVC ainda não comprovada. A execução precisa provisionar toolchain de build e não pode declarar a reescrita validada só pela pesquisa.

### 8. Registrar baseline antes de alterar o núcleo

Após a auditoria e antes do primeiro corte de implementação, criar `docs/native-core-rewrite.md` com a decisão acima, fronteiras mantidas/migradas e resultados medidos; não entregar só uma recomendação de Rust. Criar `tests/core-benchmark.cjs`, executado por Electron, com `--app-root` apontando uma raiz de build capturada e `--candidate-root` apontando a raiz nova. Cada amostra roda em subprocesso Electron e `appData` temporário próprio, sem carregar duas versões no mesmo processo; aceitar somente backend do laboratório e produzir JSON sanitizado em `--output`. Preservar no laboratório o build antigo com `.vite`, assets e dependências de runtime necessários, sem segredos/perfis reais; não embutir segunda engine no produto. Medidas com esse harness são da bridge/app sob host controlado; a paridade do executável Squirrel é prova separada.

Gerar uma única fixture sintética consistente com SQLite v5, identidades Ed25519/usuários locais e mensagens válidas de 128 bytes, em duas escalas: 1.000 e 50.000 mensagens distribuídas por seis autores; incluir uma lacuna conhecida por autor. Fazer backup SQLite consistente e derivar cópias equivalentes para antigo/novo. Não copiar somente o arquivo principal com WAL aberto. Não usar dados reais ou alterar o formato dos envelopes para facilitar o benchmark.

Medir o caminho completo da bridge, incluindo custo FFI, verificação e persistência, e não apenas uma função Rust isolada: assinatura/verificação, persistência com duplicata/conflito, leitura de prefixo contíguo e histórico recente validado. Registrar p50/p95, CPU, RSS/working set de todos os processos do app, event-loop lag, inicialização, crescimento do banco/WAL e tamanho do pacote. Separar rede do laboratório e etapas de câmera/codec; Node crypto, SQLite e codecs já são nativos na referência.

Executar 3 aquecimentos e 30 amostras pareadas por workload na mesma máquina, plano de energia, perfil de dados e versão Electron; alternar antigo/novo e registrar versões/hardware. Cada amostra reúne 100 operações e registra sua latência p50/p95, CPU e pico de memória; não calcular p95 com uma única chamada. Para cada métrica, usar bootstrap pareado de 10.000 reamostragens com semente fixa `0x4c415250` e IC de 95% da diferença de medianas entre as amostras; documentar ruído em vez de prometer percentuais antecipados.

Critério da migração: nenhum cenário funcional/segurança regride; nenhuma métrica primária de latência p95, CPU ou memória do workload piora consistentemente (IC inteiro acima de zero), e ao menos uma métrica primária end-to-end melhora consistentemente (IC inteiro abaixo de zero). Se não houver ganho demonstrado, entregar o resultado medido como objetivo de performance não atingido e bloquear promoção da reescrita; não anunciar sucesso por redução isolada do tempo de uma função. O trabalho não pode ser declarado concluído enquanto o núcleo continuar dependendo de implementação TS antiga de domínio/persistência.


### 9. Construir a fronteira nativa sem alterar o contrato público

Criar `native/larp-core/` com `Cargo.toml`, `Cargo.lock`, `build.rs`, módulos `src/{lib,identity,storage,validation,cloud,runtime}.rs` e testes de domínio. Não existe núcleo Rust equivalente no projeto; reutilizar os contratos e SQL atuais em vez de criar segundo modelo de grupo/mensagem. Usar edition 2024, `napi`/`napi-derive` 3, build setup oficial napi-rs, Node-API 8 e alvo único `x86_64-pc-windows-msvc`. Usar `rusqlite = "=0.42.0"` com `default-features = false` e `["bundled","backup","cache"]`; `ed25519-dalek = "=3.0.0"` com `pem`, `pkcs8` e `zeroize`, sem `legacy_compatibility`/`hazmat`; Serde para contratos de domínio, não para recanonicalizar envelopes. Resolver demais dependências estáveis compatíveis e registrar versões exatas em `Cargo.lock`; dependências novas exigem verificação RustSec/licença antes de entrar na release.

Na execução, instalar toolchain estável com rustup sem mudar o default global, ler a versão resolvida e fixá-la em `rust-toolchain.toml`; ela precisa atender pelo menos MSRV 1.89.0. Usar MSVC/Windows SDK existentes ou laboratório Windows/CI com essas ferramentas, sem instalar IDE/SDK ou elevar permissões no host silenciosamente. Se toolchain/linker não puderem ser disponibilizados, a implementação nativa fica bloqueada, não substituída por stub.

Criar `src/main/native-core.ts` (loader/orquestração do host), `src/main/platform-secrets.ts` (somente cofre Electron), `src/main/supabase-transport.ts` (somente SDK/transporte) e `src/shared/native-core-contracts.ts` (contrato privado). Contrato exportado pelo addon, novo e deliberado:

```ts
interface NativeLarpCore {
  request(requestJson: string): Promise<string>;
  ingestCloudEvent(subscriptionId: string, epoch: number, eventJson: string): Promise<void>;
  close(): Promise<void>;
}
function openCore(
  userDataPath: string,
  hostCall: (requestJson: string) => Promise<string>,
  onCoreEvent: (eventJson: string) => void,
): Promise<NativeLarpCore>;
```

O JSON interno usa `{ version: 1, op, payload }` e resposta `{ version: 1, ok: true, value }` ou `{ version: 1, ok: false, error: { code, message } }`. `op` é união fechada dos nomes de métodos de domínio de `LarpBridge`, excluindo `listDisplaySources`, `prepareDisplayCapture`, `setScreenViewerExpanded`; acrescentar somente `authStorage:getItem`, `authStorage:setItem`, `authStorage:removeItem` para callbacks privados do SDK. Payloads reutilizam os argumentos dos respectivos canais IPC; funções de callback do renderer nunca atravessam JSON. Rejeitar versão/op/campos inválidos; nenhum SQL, nome de tabela, URL de download, caminho ou comando de execução livre é aceito pelo renderer.

`hostCall` aceita somente três famílias fechadas: cofre (`available`, `encrypt`, `decrypt`), codec (`project-envelope`) e transporte cloud. Cloud permite as RPCs já enumeradas na etapa 3, leitura/insert/update dos campos atuais de perfil, sessão/login anônimo, `turn-credentials` e abrir/enviar/presença/fechar os canais privados existentes. Não disponibilizar `client` ou `.from()`/`.rpc()` arbitrários à UI. Configuração aprovada e caminhos são fixados no main; o Rust valida configuração e interpreta resultados. O SDK permanece responsável por seu protocolo de rede, refresh, JWT e HTTP/WebSocket; não manter nele regras de domínio antigas.

Fixar o formato de `hostCall` em `{ version: 1, kind: 'secrets' | 'codec' | 'cloud', op, payload }`, usando a mesma união de resposta `ok/value/error` do núcleo. Para `secrets`, `available` recebe `{}` e retorna booleano; `encrypt` recebe `{ plaintextBase64 }` e retorna `{ ciphertextBase64 }`; `decrypt` recebe `{ ciphertextBase64 }` e retorna `{ plaintextBase64, shouldReEncrypt }`. Para `codec`, `project-envelope` recebe `{ envelopeJson }` e retorna a projeção definida na etapa 10.

Para `cloud`, a união de `op` é `get-session|sign-in-anonymously|rpc|get-profile|list-profiles|insert-profile|update-profile|get-turn|open-channel|send-signal|track-presence|close-channel|dispose`. `rpc` recebe `{ name, args }`, com `name` limitado às RPCs da etapa 3; perfis recebem os mesmos IDs/campos/arrays já usados no serviço atual; `get-turn` recebe `{ groupId }`; operações de canal recebem `{ subscriptionId, epoch, groupId }` e o envelope/snapshot original quando aplicável. `get-session`, `sign-in-anonymously` e `dispose` recebem `{}`. Devolver `{ data, error }` do SDK como `value` para que o Rust interprete erros e respostas; exception do adaptador rejeita a operação, não retorna dados falsos. Preservar o caso `23505` e nunca converter falha de rede em autorização. `dispose` para auto-refresh/remove canais/desconecta Realtime. Storage SDK chama somente os três ops privados `authStorage:*`, com `{ key }` ou `{ key, value }`; operações void usam `null` internamente e são convertidas para `undefined` no retorno público.


Inscrições usam IDs gerados no main, associados a janela/grupo/epoch. Evento nativo é `{ subscriptionId, epoch, kind, payload }`, com `kind` em `members|presence|signal|error`; eventos com ID/epoch encerrados são rejeitados. Preservar a API pública de inscrição que retorna cancelador síncrono, mesmo quando a criação remota ainda está pendente. Se cancelar antes da abertura, invalidar epoch e fechar o canal que terminar de abrir.

Toda operação pública continua entrando por `assertTrustedFrame` e métodos específicos do preload; não expor `request`, `hostCall`, storage de Auth ou addon em `window.larp`. Manter todas as assinaturas/DTOs de `src/shared/contracts.ts`, incluindo `inserted|duplicate|conflict`, lease booleano e estado offline. O Rust não tem como autenticar `BrowserWindow` sozinho.

### 10. Portar domínio e persistência, preservando o protocolo v1

Implementar nesta ordem de dependências, ainda sem habilitar o núcleo novo no app distribuído:

1. **Compatibilidade do codec:** manter `src/shared/webrtc-protocol.ts` como codec TS único do protocolo v1. Mover a função privada `serializeEnvelope` de `src/main/peer-message-store.ts:11-48` para esse arquivo como `serializeStoredEnvelope(value: unknown, kind: 'chat' | 'ack'): string`, preservando ordem dos campos e objeto de assinatura. Adicionar adaptador privado `projectEnvelope(envelopeJson: string)` no main: interpretar uma única fotografia, usar `parseProtocolEnvelope`, `envelopeSigningBytes` e o serializador de armazenamento, e devolver metadados, assinatura, bytes assinados e JSON persistível. Rejeição retorna os códigos atuais de parsing. Nunca aceitar projeção/bytes/metadados fornecidos separadamente pelo renderer.

   Definir o retorno privado `projectEnvelope(envelopeJson: string): EnvelopeProjection | { ok: false; code: ProtocolErrorCode }`. `EnvelopeProjection` tem `ok: true`, `envelopeJson: string`, `signingBytesBase64: string`, `storageJson: string | null`, `signature: IdentitySignature`, `header: { kind: SignedProtocolEnvelope['kind']; groupId: string; senderId: string; recipientId: string | null; messageId: string | null; sequence: number | null; authorId: string | null; requestId: string | null; afterSequence: number | null; throughSequence: number | null; limit: number | null }` e `messages: EnvelopeProjection[]` (somente os chats de um sync-batch; vazio nos demais casos). Campos não aplicáveis ficam nulos; não inferir outro autor pelo transporte. O main converte JSONs opacos retornados em DTOs antes de responder ao preload, preservando a API da UI.

2. **Wire sem conversão destrutiva:** Rust trata `envelopeJson` e JSON persistido como strings opacas, obtendo projeção do codec confiável via `hostCall`; não desserializar o conteúdo assinado em `serde_json::Value` para reescrever. O JSON externo escapa o interno, preservando `\\ud800` e outros casos UTF-16 aceitos por JS. Preservar remoção apenas da assinatura externa, assinaturas internas de sync, datas originais e limites JS de inteiros seguros. Assinaturas usam Ed25519 puro e os mesmos bytes UTF-8, sem normalizar Unicode, timezone, PEM ou histórico. Assinatura genérica de string passa ao núcleo como bytes UTF-8/base64 produzidos no main, preservando a conversão original de strings JS.
3. **Identidade/cofre:** portar leitura/validação do registro v1, criação Ed25519, importação PKCS#8/SPKI, comparação da pública derivada, assinatura e verificação para `identity.rs`. Usar CSPRNG do SO via `getrandom` para chaves/convites e propagar falha de entropia, sem seed previsível ou fallback. `platform-secrets.ts` usa somente `isAsyncEncryptionAvailable`, `encryptStringAsync` e `decryptStringAsync(...).result` depois de `app.whenReady()`, APIs confirmadas no Electron instalado. Preservar arquivos e decriptar ciphertext legado pela API pública; não implementar AES/DPAPI/`Local State` internos no Rust. Não adicionar cache permanente de chave privada em plaintext; importar material somente para a operação e limpar buffers controláveis ao terminar. Strings imutáveis e cópias internas do V8 não têm promessa de zeroização.
4. **Persistência:** portar schema v5, cache, mensagens/ACKs, migrações e transações para `storage.rs`, usando SQL parametrizado e uma conexão pertencente a um worker Rust dedicado, fora do event loop JS. Preservar PK global de mensagem, unicidade grupo/autor/sequência, FK de ACK, idempotência e ausência de overwrite em conflitos. Retornar sucesso de escrita somente após commit; ler prefixo com cursor de linhas e interromper na primeira lacuna, sem materializar todas as sequências num `Vec` nem trazê-las ao JS. Manter WAL, foreign keys e prepared statements reutilizados.
5. **Domínio:** portar para `validation.rs` as validações de configuração, UUID/sequência, respostas de RPC/linhas, perfis/WebP/base64 e cache; para `cloud.rs`/`runtime.rs`, autorização local por usuário/grupo/chave, refresh single-flight, estados cloud, convites aleatórios/hash, presença, membership e coordenação de inscrições. Preservar a diferença entre limites medidos por `String.length` JS (unidades UTF-16), `Array.from(name).length` (pontos de código) e bytes UTF-8. Implementar a semântica ECMAScript de trim, não assumir que `str::trim()` é equivalente; incluir vetores BOM/NEL, emoji e nome exatamente no limite. Reler associação pelas mesmas fronteiras autenticadas para operações privilegiadas; cache offline não autoriza novas transmissões online.
6. **Transporte sem domínio duplicado:** `supabase-transport.ts` executa operações pedidas pelo núcleo e devolve dados/erros brutos. Rust mantém derivação do usuário a partir da sessão real, respostas tabulares versus escalares, perfil insert→`23505`→update só dos campos editáveis, canal privado `group:<uuid>`, identidade de presença e eventos obsoletos. Não reimplementar SDK Supabase comunitário, login, RPCs ou algoritmo criptográfico para aparentar uma conversão integral.

Separar fila do storage Auth, worker SQLite e tarefas de runtime. Nunca manter transação/mutex de domínio aguardando `hostCall`: `getSession()` reentra no storage SDK e uma fila global bloqueada causaria deadlock. `openCore` inicializa apenas estado local/cofre/banco; construir SDK e iniciar refresh somente após o handle nativo estar disponível ao adaptador de storage.

Limitar admissão antes de efeitos: no máximo 64 requests pendentes e 8 MiB de entradas enfileiradas; callbacks/eventos com fila de 128 entradas e 8 MiB. Esses limites internos novos evitam trabalho/memória sem teto, sem reduzir os limites de envelope/perfil existentes. Saturação de request rejeita com `queue-full`; saturação de evento não pode descartar sinalização/membership silenciosamente: invalidar inscrição e notificar erro, exigindo releitura/reconexão. Presença pode coalescer somente snapshots da mesma inscrição. Falha do núcleo retorna `core-unavailable`; versão/payload inválidos, `invalid-request`; contexto revogado, `stale-context`; falha durável, `storage-failed`. Mapear erros para mensagens atuais em português na fronteira, sem vazar segredos.

O erro de overflow não pode depender de espaço livre na mesma fila de dados cheia: manter notificação de falha pendente fora dessa fila e entregá-la assim que o callback drenar, com inscrição já invalidada. Enquanto isso, novas operações dessa inscrição falham fechado. Nenhum mutex/permit de escrita deve esperar essa notificação.


Copiar Buffer/TypedArray mutável para memória Rust owned **na entrada síncrona antes** de despachar worker. Não guardar referência JS mutável nem `&mut self` assíncrono marcado unsafe para contornar o borrow checker. Domínio Rust deve proibir unsafe próprio; FFI gerada e SQLite C continuam dependências auditáveis, não memória-segurança integral do executável.

### 11. Migrar dados e cortar a implementação antiga de forma limpa

Antes de abrir cloud ou consumidores, exigir exclusividade entre instâncias da versão nova com `app.requestSingleInstanceLock()`, preservando o caminho `userData` instalado e `Larp-dev`. Testar handoff Squirrel com a versão anterior encerrada: ela não respeita um lock novo, portanto não alegar exclusividade entre versões apenas porque o novo binário tem mutex.

Preservar o perfil Chromium inteiro, inclusive `Local State` e preferências de `localStorage`; não criar nova conta, origem, diretório ou formato criptográfico como consequência da troca de linguagem. Distinguir ausência legítima de arquivo e corrupção. Para registro existente, exigir a mesma pública Ed25519; para sessão, preservar o mapa completo `{ version: 1, values }`, inclusive chaves desconhecidas, e restaurar o mesmo usuário antes de `register_identity`. Falha de decrypt/restauração não dispara login anônimo substituto.

Para SQLite v5, abrir a mesma base sem alterar `user_version` ou reserializar mensagens. Em bases antigas, fazer backup consistente pela API SQLite, portar a migração de cache/perfis em transação e **preservar tabelas legadas** em vez de repetir o `DROP TABLE` histórico de v4. Versão maior que 5 falha sem escrita. Backup/corrupção/disco cheio/erro de importação devem impedir o corte destrutivo, nunca resetar banco/identidade.

Não regravar todos os ciphertexts só para concluir migração. `shouldReEncrypt` é informação de rotação do cofre; se for recriptografar por exigência do provider ou numa escrita posterior, usar o resultado já decriptado e substituição durável, sem loop de decrypt e sem apagar o registro anterior antes do sucesso. Serializar writes Auth; criptografar antes de persistir, temporário exclusivo/flush/substituição segura no Windows. Falha de durabilidade rejeita a operação. Nunca restaurar automaticamente backup antigo de sessão após refresh: tokens podem já ter rotacionado remotamente; resultado ambíguo precisa de erro explícito, não reexecução cega.

Fazer o corte numa única implementação escritora:

- Trocar `registerIpcHandlers(database, getMainWindow, runtime)` por `registerIpcHandlers(getMainWindow: () => BrowserWindow | null, core: NativeLarpCore): void`; o único caller de produção é `src/main/index.ts`, confirmado por LSP. Ele aguarda o novo `openCore`, registra IPC e só então libera a UI/cloud. Manter captura/maximização no host; os demais handlers apenas autenticam frame, fixam contexto e encaminham a operação ao núcleo. Revalidar janela/documento/epoch após awaits antes de emitir resultados/eventos.
- Migrar todos os callers antes de remover `src/main/{database,peer-message-store,profile-validation}.ts` e `src/main/services/{identity,runtime,supabase-groups}.ts`. Não manter reexports, classes antigas, writers duplos ou fallback TS. Referências LSP já confirmam `createLarpDatabase` em `main/index.ts` e testes de banco; `createPeerMessageStore` em `main/database.ts`; `createIdentityManager`/`createCloudSetup` em `services/runtime.ts`; `SupabaseGroupsService` em runtime e testes cloud; validadores em IPC/banco/cloud e testes. Repetir referências semânticas dos exports remanescentes antes de cada remoção para capturar mudanças posteriores ao plano.
- Portar cenários comportamentais de `tests/database.test.ts`, `tests/profile-validation.test.ts` e `tests/supabase-groups.test.ts` para testes Rust de storage/validation/cloud e testes do addon/host. Remover os três arquivos antigos somente após essa cobertura existir; descartar asserts de wording/wiring em vez de repiná-los. Manter testes de protocolo, mídia e integração reais. Nenhum teste novo pode validar autorização apenas com um mock que sempre permite.
- Em `before-quit`, usar fechamento assíncrono guardado: impedir novas operações, invalidar epochs, parar canais/auto-refresh SDK, drenar writes, fechar SQLite e liberar callbacks; então concluir `app.quit()` sem recursão. `close()` é idempotente e não depende do GC. Escrita falhada não vira sucesso no shutdown; callbacks rejeitados precisam resolver/rejeitar seus consumidores, sem processo pendurado.

### 12. Empacotar e validar a versão Rust antes de promover

No `package.json`, adicionar `@napi-rs/cli` 3 como devDependency resolvida com versão exata e configuração `napi.binaryName = "larp_core"`/alvo Windows x64. Definir `build:native` como `napi build --release --target x86_64-pc-windows-msvc --manifest-path native/larp-core/Cargo.toml --output-dir native/larp-core/dist --dts index.d.ts -- --locked`; gerar o lockfile inicialmente e nunca atualizar dependências durante build de release. Manter npm; não adotar o scaffold Yarn/pnpm do framework.

Executar `build:native` nos hooks npm `prestart`, `pretest`, `prepackage` e `premake`. O loader usa caminho absoluto fixo: em desenvolvimento, `join(__dirname, '../../native/larp-core/dist/larp_core.node')` a partir de `.vite/build`; empacotado, `join(process.resourcesPath, 'larp_core.node')`. Adicionar esse binário a `forge.config.js:extraResource`. Não buscar addon no PATH, fazer download em runtime ou tentar engine TS se a carga falhar; ausência/ABI incompatível aparece como falha nativa de inicialização.

Após o corte, remover `better-sqlite3`, seus tipos e a exceção de bundle em `vite.main.config.ts`, mais whitelist/unpack específicos no Forge. Manter apenas recursos/arquivos efetivamente necessários e a cadeia Squirrel existente; não mudar para Tauri/NSIS/MSI nem publicar release durante testes. No workflow Windows atual, provisionar a versão Rust fixada e executar testes Rust/addon antes do mesmo build/validação commit-tag-artefatos. Atualizar a lista explícita de `npm test` para a cobertura portada e `tests/native-core.test.ts`, sem perder os demais testes existentes.

Adicionar `tests/native-core.test.ts` para carregar o `.node` real no Node compatível e `tests/native-core-electron.cjs` para o Electron empacotado/host real; são fronteiras não cobertas pelos testes atuais. Exercitar sucesso e rejeição de callbacks, bytes/campos adulterados sem aceitação, queue-full sem commit, reentrada Auth sem deadlock, cancelamento antes da abertura, evento de epoch antiga, fechamento com writes pendentes e identidade/sessão legadas de fixture. O transporte interno usa strings JSON/base64 imutáveis; não inventar teste de mutação de Buffer numa API que não recebe Buffer. Não usar stub do addon nem inserir permissões automáticas de captura no produto para fazer a prova passar.

Rodar novamente os cenários de segurança das etapas 3–6 contra o caminho Rust, preservando os resultados antigos no relatório. Defeitos confirmados nos módulos reescritos não devem ser copiados como “paridade”; implementar a correção correspondente no núcleo e exigir o teste adversarial falhar antes/passar depois. A reescrita não autoriza alterar Auth/RLS, política de histórico ou dados em produção; achados dessas fronteiras continuam bloqueios explícitos do roteiro, nunca resolvidos por alegação de Rust.

Exigir paridade de instalação/update Squirrel em VM e de seis participantes, chat/histórico offline, voz, tela/janela com áudio opcional, dispositivos, reconexão, revogação e troca de grupo. Comparar benchmarks da etapa 8 e auditar o novo grafo de dependências nativas. Sem ambiente para provar alguma fronteira, a reescrita pode ter código implementado, mas não recebe status de pronta para produção nem de ganho de performance comprovado.

## Verificação

### Comandos e pré-condições

Executar somente após aprovação, a partir da raiz do checkout. Estes comandos iniciais cobrem a fase de auditoria da versão atual; a instalação explícita das ferramentas/dependências da trilha Rust ocorre somente nas etapas 9–12, sem reparos ou upgrades automáticos do produto.

```powershell
npm run typecheck
npm test
.\node_modules\.bin\tsx.cmd --test tests/security-protocol.test.ts
```

No diretório temporário de laboratório, usar a mesma versão exata de CLI registrada na etapa 1: `npx --yes supabase@<versão> test db`. Copiar também o novo SQL para esse laboratório antes da execução. Testes SQL devem produzir assertions pgTAP reais, não zero testes; migrations incompletas são falha de preparação, não aprovação de autorização.

Na raiz, com URL/chave pública obtidas exclusivamente do laboratório:

```powershell
$env:LARP_TEST_SUPABASE_URL = 'http://localhost:54321'
$env:LARP_TEST_SUPABASE_ANON_KEY = '<chave pública local>'
$env:LARP_TEST_SUPABASE_ISOLATED = 'true'
npm run test:supabase
npm run package
$env:LARP_SUPABASE_URL = $env:LARP_TEST_SUPABASE_URL
$env:LARP_SUPABASE_ANON_KEY = $env:LARP_TEST_SUPABASE_ANON_KEY
.\node_modules\.bin\electron.cmd tests/security-electron.cjs
```

`<versão>` e `<chave pública local>` são valores descobertos do laboratório, não placeholders a deixar nos arquivos entregues. O harness Electron deve recusar backend não loopback antes de carregar a aplicação. Manter a configuração pública distribuída intacta e bloquear saída para produção durante toda prova de runtime. Executar somente o check focado após construir cada instrumento; não repetir suítes para confirmar falhas já observadas.

### Verificação específica da reescrita

Com o laboratório da etapa 1 disponível, toolchain Rust/MSVC preparados e o corte de implementação concluído, executar na raiz:

```powershell
cargo test --manifest-path native/larp-core/Cargo.toml --locked
npm test
npm run typecheck
npm run test:supabase
npm run make
.\node_modules\.bin\electron.cmd tests/native-core-electron.cjs
.\node_modules\.bin\electron.cmd tests/core-benchmark.cjs --app-root "$env:LARP_BASELINE_ROOT" --candidate-root . --output "$env:LARP_LAB/native-comparison.json"
```

Definir `LARP_BASELINE_ROOT` com a raiz capturada na etapa 8 e `LARP_LAB` com o diretório descartável, além das variáveis Supabase já documentadas (`LARP_TEST_*` e `LARP_SUPABASE_*`, incluindo chave pública e flag de isolamento). `npm test` cobre os cenários JS/addon da lista portada; a primeira linha executa os testes de domínio Rust. Os hooks de build podem reutilizar cache Cargo; não reconstruir com flags de debug para comparar contra baseline release.

Para a prova do pacote, `tests/native-core-electron.cjs` deve lançar `out/Larp-win32-x64/Larp.exe` real como subprocesso na VM/conta descartável, não só importar o bundle em um host `isPackaged=false`. Controlar a bridge pelo CDP habilitado somente no processo de ensaio, com endereço `127.0.0.1`/porta temporária e firewall restrito ao laboratório; não habilitar depuração no lançamento normal nem modificar defaults de release. Fechar subprocessos e conexões do próprio ensaio ao terminar.


Oráculos adicionais:

| Prova nativa | Entrada | Resultado exigido |
|---|---|---|
| Wire/assinatura | Vetores dos nove tipos, nested signatures, NFC/NFD, surrogate isolado, chaves reordenadas, datas v1 e sequência máxima JS | Mesmos bytes assinados; Node verifica Rust e vice-versa; persistência antiga continua verificável sem normalização |
| Cofre legado | Perfil sintético Electron 45 com ciphertext síncrono e sessão existente | Adaptador assíncrono recupera a mesma pública e o mesmo usuário; corrupção falha sem nova identidade/login |
| Migração SQLite | Fixtures v2/v3/v4/v5, colunas v5 com `user_version=4`, WAL pendente e mensagens/ACKs assinados | Backup consistente, dados mantidos, schema v5 correto e tabelas legadas não apagadas |
| Domínio Rust | Outsider B tenta gravar/ler/sinalizar em A; evento de epoch encerrada; fila saturada | Nenhum acesso/commit indevido; evento obsoleto rejeitado; saturação observável e sem fallback TS |
| Vida útil | Refresh SDK reentra no storage Auth; fechar com write pendente | Sem deadlock; write tem resultado durável ou erro explícito; callbacks/SQLite/SDK fechados |
| Distribuição | Instalação nova e upgrade Squirrel em VM; addon removido ou corrompido para provocar erro de carga | Addon real carrega e funções permanecem; erro de carga falha fechado, sem download ou outra engine. Detectar código malicioso ainda carregável depende da cadeia de confiança auditada, não deste smoke |
| Performance | Mesmo workload antigo/novo, métricas completas e IC documentados | Critério da etapa 8 satisfeito; sem ganho medido, objetivo não atingido e promoção bloqueada |

Teste de downgrade é somente em cópia descartável: não assumir que o safeStorage síncrono antigo decripta todos os novos ciphertexts assíncronos. Se não houver compatibilidade reversa, declarar downgrade do perfil incompatível e bloquear restauração automática de binário/sessão, preservando recuperação controlada; a migração de leitura legado→novo continua obrigatória.


### Oráculos mínimos obrigatórios

| Prova | Entrada concreta | Evidência de sucesso do controle |
|---|---|---|
| Instrumento de isolamento | Consultar coluna inexistente propositalmente em fixture do teste de ferramenta | O cenário falha como erro de consulta; nunca relata negação de acesso bem-sucedida |
| A/B | U4 chama REST/RPC de B; U3 permanece em A/B | U4 recebe negação/zero dados pela fronteira apropriada; leitura positiva de U3 funciona; nenhuma alteração em B |
| Concorrência | U9/U10 aceitam convites diferentes de A com cinco membros | Um sucesso, um `group is full`, seis membros; convite perdedor continua não consumido |
| Revogação | Remover U4 com canal e mídia ativos, tentar novas operações e reconectar | REST/RPC negam; cessação de entrega/peer medida; qualquer janela/vazamento residual documentado com impacto |
| Protocolo/persistência | Envelope válido, adulteração, replay e lote com assinatura interna falsa | Válido persiste e entrega uma vez; adulterado não entrega/persiste; conflito não sobrescreve |
| IPC | Janela estrangeira invoca assinatura, leitura de histórico e preparação de captura | Rejeição real sem efeitos; janela legítima mantém fluxo autorizado |
| Captura | Seleção sintética consumida duas vezes; stop com captura pendente | Segunda tentativa negada; todas as faixas terminadas; nenhum loopback sem opção explícita |
| TURN | Token ausente, outsider e membro contra função local | 401/403/200 respectivamente com pré-requisitos configurados; segredo sintético não é confundido com prova de revogação no relay |
| Relatório | Um controle falha ou seu ambiente falta | ID/evidência/reteste quando há defeito; `não verificado` e parecer bloqueado quando falta prova, nunca status verde por mock |

Registrar comando, ambiente, identidade lógica, código de saída, contagens e resultado observado de cada ensaio; não inventar logs nem reutilizar registros históricos de README como prova atual. Uma falha de segurança corretamente reproduzida é resultado válido da auditoria, não motivo para ocultar o teste ou corrigir silenciosamente o produto.

## Premissas e contingências

- Escolhas do usuário: distribuição pública por convite, vários grupos privados e participantes potencialmente maliciosos; auditoria com testes/roteiro, seguida da reescrita real do núcleo em Rust, preservando React/Electron e todos os recursos de mídia. Não substituir a implementação solicitada por relatório/benchmark apenas.
- Se aparecer necessidade de mudar Auth, política de histórico, protocolo, limite de membros ou provedor, registrar proposta e efeito no roteiro; não executar decisão de produto sob pretexto de auditoria.
- Sem Docker/CLI, dispositivo/VM, configuração segura ou acesso operacional, concluir as trilhas alcançáveis e listar precisamente a evidência ausente e o procedimento já especificado para obtê-la. Não criar infraestrutura paga, reduzir os critérios nem declarar prontidão por falta de ambiente.
- Backups/recuperação não significam prometer recuperação da identidade ou histórico central que o produto não oferece; avaliar e explicitar o modelo atual e suas perdas possíveis.

## Referências para os critérios

- [Segurança Electron](https://www.electronjs.org/docs/latest/tutorial/security).
- [Segurança dos produtos Supabase](https://supabase.com/docs/guides/security/product-security.md) e [checklist de segurança de produção](https://supabase.com/docs/guides/security/production-checklist.md).
- [Autorização Realtime](https://supabase.com/docs/guides/realtime/authorization.md): autorização ao entrar no canal não comprova revogação de conexão existente; verificar também configuração de acesso público e eventos DELETE.
- [CLI local](https://supabase.com/docs/guides/local-development/cli/getting-started.md) e [mudança de comportamento da CLI v3](https://supabase.com/changelog/supabase-cli-v3): conferir versão/ajuda e manter comandos exclusivamente locais.
- [Configuração da CLI](https://supabase.com/docs/guides/local-development/cli/config) e [Auth anônima](https://supabase.com/docs/guides/auth/auth-anonymous.md): parâmetros do laboratório e distinção entre sessão autenticada e papel `anon`.
- Rust: [ownership e ausência de GC obrigatório](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) e [limites de unsafe/FFI](https://doc.rust-lang.org/book/ch20-01-unsafe-rust.html).
- Comparação: [C# e gerenciamento de memória](https://learn.microsoft.com/en-us/dotnet/csharp/tour-of-csharp/overview) e [tradeoffs do GC de Go](https://go.dev/doc/gc-guide).
- Integração: [Node-API](https://nodejs.org/api/n-api.html), [napi-rs 3](https://napi.rs/docs/introduction/getting-started), [compatibilidade](https://napi.rs/docs/more/support-compatibility), [async](https://napi.rs/docs/concepts/async-fn), [build](https://napi.rs/docs/cli/build), [buffers/lifetimes](https://napi.rs/docs/concepts/typed-array) e [memory cage Electron](https://www.electronjs.org/blog/v8-memory-cage).
- Dados: [safeStorage e compatibilidade legada](https://www.electronjs.org/docs/latest/api/safe-storage), [SQLite backup](https://www.sqlite.org/backup.html), [SQLite WAL](https://www.sqlite.org/wal.html), [rusqlite 0.42](https://docs.rs/crate/rusqlite/0.42.0/features), [ed25519-dalek 3](https://docs.rs/ed25519-dalek/3.0.0/ed25519_dalek/).
- Runtime não selecionado: [modelo de segurança Tauri](https://v2.tauri.app/security/), [WebView2 usado no Windows](https://v2.tauri.app/reference/webview-versions/) e [limitação rastreada de seletor próprio de captura](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2442).
