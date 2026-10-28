# Arquitetura do Larp

## Escopo

Aplicativo desktop Windows x64 para grupos privados de até seis participantes. Electron Forge + Vite, React e TypeScript. O renderer apresenta os grupos à esquerda, conversa ao centro, membros à direita e controles de voz sempre acessíveis. Os únicos grupos apresentados vêm do Supabase ou de metadados reais em cache; conteúdo em cache é somente leitura offline.
 

## Componentes e dados

| Componente | Responsabilidade | Localização |
|---|---|---|
| Processo principal Electron | Identidade segura, configuração Supabase, SQLite, permissões, captura e validação IPC | `src/main/` |
| Preload | API tipada mínima; sem expor Node, IPC genérico ou credenciais ao renderer | `src/preload/` |
| Renderer | Interface pt-BR, malha WebRTC, chat e controles de mídia | `src/renderer/` |
| Protocolo compartilhado | Envelopes assinados e versionados para chat, ACK, sincronização e sinalização | `src/shared/webrtc-protocol.ts` |
| Banco remoto | Identidade pública, grupo, associação, perfis, convites e concessão de tela; políticas RLS | `supabase/migrations/` |
| Edge Function | Credenciais TURN autorizadas por associação ativa | `supabase/functions/turn-credentials/` |

O SQLite fica em `app.getPath('userData')/larp.sqlite`. Mensagens não são enviadas ao banco Supabase. `identity.json` guarda a chave privada Ed25519 criptografada por `safeStorage`; `supabase-session.json` guarda a sessão anônima criptografada pelo mesmo mecanismo. Perder esses arquivos remove a identidade local; não há recuperação ou transferência entre PCs.

Na atualização do SQLite para a versão 4, o Larp apaga permanentemente as tabelas locais antigas `messages`, `participants` e `groups`, incluindo anotações salvas dentro dos grupos de demonstração; essas anotações não são exportadas. As tabelas de cache Supabase e os envelopes/ACKs P2P assinados permanecem intactos.

SQLite v5 adiciona `display_name` e `avatar_data` anuláveis a `cached_cloud_members`. A migração v4 preserva grupos/membros em cache, mensagens P2P assinadas e ACKs; perfis ausentes permanecem nulos.

## Identidade, grupos e custo

A primeira execução cria uma chave Ed25519 local. A chave pública é registrada na sessão Supabase anônima. O cliente usa somente URL e chave pública `anon`/publishable; rejeita chave `service_role` e não embute segredos administrativos.

As migrações em ordem definem políticas RLS, funções transacionais e índices. Convites guardam somente hash, expiram em até sete dias e são de uso único. A aceitação bloqueia a linha do grupo e conta membros na mesma transação, impondo seis participantes mesmo sob entrada simultânea. Proprietários podem revogar convites/remover membros; ao sair, o proprietário é transferido ao membro mais antigo ou o grupo vazio é removido. A associação e a reserva de tela são verificadas pelo servidor.

## Perfis compartilhados

`public.larp_user_profiles` armazena um nome opcional e uma URI de dados WebP por usuário autenticado. `private.can_view_profile` permite leitura apenas pelo dono e por membros autenticados que compartilham um grupo privado com ele. As políticas de inserção e atualização vinculam `user_id` a `auth.uid()`; privilégios por coluna impedem alterar o dono. RLS está ativada e forçada; `anon` não recebe privilégios na tabela. O cliente insere o perfil e, em conflito de chave, atualiza somente `display_name` e `avatar_data`: o `upsert` do PostgREST também atualizaria `user_id`, que não deve receber privilégio UPDATE.

O renderer envia somente `displayName` e `avatarData`; o IPC deriva o ID do usuário a partir da sessão autenticada. Nomes são aparados e limitados a 32 caracteres Unicode. O seletor aceita imagens de origem até 8 MiB e armazena uma miniatura WebP centralizada de 128 × 128, até 48 KiB. Limpar os dois campos restaura o pseudônimo do PC. Perfis apenas decoram as visualizações atuais de membros e mensagens; envelopes assinados e histórico local permanecem inalterados.

O SQLite armazena esses campos de perfil junto a cada membro de grupo para exibição offline; perfis em cache são somente leitura. A versão 5 adiciona colunas anuláveis sem descartar o cache v4 nem o histórico assinado.

O custo zero depende da escolha e configuração das contas do operador. O aplicativo não ativa planos pagos, não instala fallback pago e não tem mecanismo de cobrança. Supabase ou ExpressTURN podem suspender serviço por limite, inatividade ou mudança de termos. Operadores devem verificar que não há cartão, upgrade automático ou forma de cobrança antes da implantação. Quando Supabase não está disponível, o histórico local continua acessível; sem TURN, o aplicativo tenta conexão direta por STUN.

## Sinalização e malha P2P

O cliente autentica uma sessão anônima Supabase e usa canais Realtime privados `group:<uuid>`, autorizados por RLS para membros atuais. A sinalização é endereçada ao destinatário, versionada e assinada; envelopes inválidos, fora do grupo, enviados por usuário não associado ou acima do limite de tamanho são descartados. Candidatos ICE são enviados em lotes limitados.

Alterações de associação e perfil usam eventos Realtime. Mudanças de associação chegam de `larp_group_members`; mudanças de perfil, de `larp_user_profiles`. A migração 0004 publica eventos de associação e a migração de perfil publica eventos de perfil. Em ambos os casos, o cliente ignora o conteúdo do evento e relê a associação e os perfis visíveis usando RPC autenticada e RLS antes de atualizar a malha e o cache. O estado do canal não concede associação nem visibilidade de perfil.

Presença é transitória e usa o canal Realtime privado `group:<uuid>` já autorizado aos membros; não requer tabela nem migração. O processo principal valida a associação e vincula o payload à identidade Supabase autenticada. Clientes da versão atual publicam `online` enquanto a inscrição de presença do grupo estiver conectada, independentemente de foco, visibilidade ou atividade; fechar o Larp ou perder a conexão Realtime remove o estado remoto. A interface só mostra pontos após a primeira sincronização Realtime: a ausência de um membro no snapshot sincronizado significa offline, e o estado desconhecido antes disso permanece oculto. `away` continua aceito e exibido quando recebido de clientes antigos; esta versão não o publica por inatividade. Nenhuma presença fica armazenada.

Cada participante estabelece no máximo cinco conexões WebRTC. A ordenação do identificador escolhe um único dono do RTCDataChannel por par; `ordered: true` e retransmissão confiável são exigidos. A negociação trata ofertas simultâneas por rollback/polite-peer, associa respostas a IDs de negociação, agrupa candidatos ICE, reinicia ICE e tenta reconectar pares desconectados. STUN padrão é `stun:stun.l.google.com:19302`; TURN é opcional e só chega ao cliente autenticado após validação de associação pela Edge Function.

A chamada entre duas aplicações só pode ser considerada aceita depois de configurar e exercitar duas identidades independentes e dois computadores; typecheck e testes locais não comprovam sinalização, firewall, NAT ou operação do provedor.

## Chat e histórico

O processo principal valida assinatura Ed25519 e participação antes de persistir. Mensagens possuem versão, UUID, grupo, autor, sequência por autor, texto limitado e horário. Mensagens P2P de saída são persistidas neste PC antes do envio. Envelopes de entrada são verificados antes de serem aceitos; IDs/sequências repetidos são idempotentes ou conflitos, e lacunas não são apresentadas fora de ordem.


O histórico ausente é solicitado em faixas e lotes limitados. Cada participante pode entregar cópias armazenadas localmente a outro participante; o receptor valida assinatura, grupo, sequência e duplicata antes de persistir. Confirmações também são assinadas e registradas localmente. Não existe recuperação garantida se todas as cópias locais forem perdidas, e um novo membro só recebe o histórico ainda disponível nos PCs conectados.

## Voz, tela e qualidade

Voz usa `getUserMedia`, Opus quando compatível e cancelamento de eco. A supressão nativa de ruído pode ser ligada ou desligada; o Chromium e o microfone definem sua intensidade automaticamente. A preferência fica salva neste PC. O sender de voz tem teto de 96 kb/s; o áudio de sistema da tela tem teto de 192 kb/s por peer, sem taxa mínima, e mantém o controle de congestionamento do WebRTC. A captura de sistema prefere dois canais (`ideal: 2`) e marca suas faixas de áudio como `music`, sem aplicar processamento de voz; se a origem só oferecer mono, ela continua utilizável. Captura de áudio só é permitida na janela principal e por solicitação explícita.

Cada participante remoto tem um elemento de saída de voz próprio; o áudio da tela usa uma saída distinta. Todos os elementos de voz e transmissão seguem a saída selecionada. O mudo global afeta ambas as classes; sair da chamada silencia somente a voz e não interrompe o áudio da tela. O volume global da voz multiplica o volume individual do participante. O controle individual começa no nível global e fica salvo por ID localmente; o volume da transmissão também tem controle e persistência próprios.

O protocolo sinaliza estado de mídia em envelopes assinados, direcionados por grupo e destinatário. O receptor verifica identidade de transporte, associação atual, destinatário, grupo e assinatura Ed25519 antes de aceitar `voice` ou `screen` ativo/inativo. A chamada local não depende de haver pares conectados: a pessoa pode entrar sem pares; uma conexão que chegar depois recebe a faixa local e o estado atual após a anexação. Estado de voz recebido controla apenas a saída remota; não altera o envio local nem a presença de grupo.

O palco integrado ocupa uma linha fixa entre o cabeçalho e o histórico rolável. Lista o usuário local enquanto participa e os membros com faixa de voz WebRTC remota ativa; conexões de dados, sozinhas, não são presença de voz. Áudio de tela é associado ao stream que contém o vídeo, mesmo se o evento de áudio chegar primeiro; faixas sem stream associado a vídeo são tratadas como voz. Cartões mostram avatar, nome e estado textual; atividade medida localmente destaca quem está falando, e pares em reconexão mantêm o cartão com “Reconectando”. Controles de volume por participante abrem nos cartões do palco e nas linhas de membros; o volume da transmissão abre somente no vídeo remoto, nunca na prévia local. Os popovers funcionam por clique, menu de contexto e tecla de contexto/Shift+F10. Fechamento definitivo remove a presença; mensagens remotas novas aceitas geram um tom local uma única vez.
A central de notificações registra mensagens novas e entradas em chamadas, mantém até 100 itens somente na sessão atual, marca tudo como lido ao abrir e permite voltar ao grupo quando ele ainda está disponível.

A captura de tela/janela exige seleção explícita no processo principal. Áudio de sistema começa desativado. Uma concessão SQL atômica permite uma tela por grupo; a reserva expira após 45 segundos sem renovação e é liberada ao parar ou sair. A captura e as faixas são encerradas no stop/fechamento. Tela e participantes aparecem juntos no palco; expandir mantém a transmissão dentro da janela maximizada, respeitando a área de trabalho do Windows; `Esc` retorna ao modo normal sem usar tela cheia exclusiva do sistema. A barra lateral mantém os controles de microfone, saída e configuração junto ao perfil; o dock conserva o volume mestre de voz e a entrada/saída da chamada.

O controlador prefere AV1, VP9, H.264 e VP8 conforme os codecs anunciados; a presença de codec não prova aceleração por GPU. `contentHint` é `motion` ou `text`. O orçamento total padrão é 20 Mb/s, distribuído entre espectadores, com teto de 8 Mb/s por conexão. Parâmetros são ajustados pela rota e pressão observada do codificador; áudio não participa do orçamento de vídeo. A interface apresenta resolução, FPS, codec, upload e candidato direto/relay medidos. 1080p/60 é meta, não garantia.

TURN é entregue pela Edge Function `turn-credentials`, que valida JWT e associação e obtém `EXPRESSTURN_URLS`, `EXPRESSTURN_USERNAME` e `EXPRESSTURN_CREDENTIAL` do ambiente seguro. Credenciais não entram no executável ou repositório. Se a função não fornecer credenciais, o cliente informa indisponibilidade e mantém STUN; nunca ativa serviço pago. Se o provedor ainda emitir credenciais após esgotar a franquia de relay, o cliente não dispõe de API de quota: continua tentando STUN/TURN e reporta o caminho ICE observado ou indisponível.

## Segurança Electron

O `BrowserWindow` usa `contextIsolation`, sandbox e `nodeIntegration: false`; navegação externa e janelas novas são bloqueadas. O preload oferece métodos tipados e específicos. O processo principal valida janela e frame de origem, UUIDs, limites de texto/envelope, formato dos campos de perfil e conteúdo do avatar. O IPC de perfil não aceita ID de usuário; o serviço usa a identidade Supabase autenticada. Permissões de microfone e display são restritas à janela principal; a captura de tela exige seleção de uso único no processo principal. Ao fechar a janela, a limpeza da captura usa o ID salvo de `webContents` sem acessar o `BrowserWindow` destruído. Credenciais administrativas nunca são expostas ao renderer.

## Configuração e verificação

A implantação exige Auth anônimo Supabase, migrações ordenadas, chave pública do cliente e, opcionalmente, Edge Function TURN com segredos da conta gratuita. A migration `20261026230136_fix_screen_share_lease_timestamp.sql` corrige `expires_at` para usar uma expressão `timestamptz`; ela já foi aplicada ao projeto Supabase configurado no app. Outros projetos existentes precisam aplicá-la antes de reservar compartilhamento de tela. A migration `20261027014514_larp_user_profiles.sql` também deve estar aplicada antes de iniciar esta versão; ela já foi aplicada ao projeto configurado. Ver instruções em [`../README.md`](../README.md). A política de custo zero é operacional: verificar limites e ausência de upgrade/cobrança no painel de cada provedor.

Falhas após a verificação do atualizador fecham a tela de abertura e exibem a causa em uma caixa de erro nativa, em vez de deixar “Abrindo Larp” indefinidamente. Execuções a partir do código-fonte usam o perfil `Larp-dev`, isolado do banco da instalação. A migração SQLite v5 reconhece colunas de perfil existentes mesmo se `user_version` estiver em 4; ela preserva as colunas e dados ao restaurar a versão do esquema.

Validação local do v0.2.4 em Windows x64: `npm run typecheck`, `npm test` (14 testes) e `npm run make` passaram. `npx supabase test db` foi tentado, mas o daemon Docker não estava disponível (ECONNREFUSED em 127.0.0.1:54322); a última tentativa de `npm run test:supabase` parou no login porque a Auth anônima está desabilitada.

| Ensaio | Estado |
|---|---|
| Mudança v0.5.0: áudio, presença e locutor | `npm run typecheck`, `npm test` (34 testes) e `npm run make` passaram; o build Squirrel gerou `Setup.exe`, `.nupkg` e `RELEASES`. O app empacotado abriu em perfil temporário, conectou ao serviço e não teve erros de renderer. Sem grupo nem segundo cliente, presença Realtime e destaque em chamada real não foram exercitados. Os testes cobrem persistência/constraints do microfone, estados e timeout de presença, e detecção de atividade de voz; não comprovam eficácia acústica do supressor |
| Mudança v0.6.0: áudio e palco integrados | `npm run typecheck`, `npm test` (38 testes) e `npm run package` passaram. O app empacotado renderizou em viewport 1139×668 sem overflow horizontal e com os dois controles de volume. O renderer do servidor de desenvolvimento não carregou por `504 Outdated Optimize Dep` do Vite; não foi validado WebRTC entre dois PCs nem palco com participante remoto/compartilhamento ativos |
| Mudança v0.6.2: estado de mídia e controle individual de áudio | `npm run typecheck`, `npm test` (40 testes) e `npm run make` passaram; o build Squirrel gerou `Larp-0.6.2 Setup.exe`, `Larp-0.6.2-full.nupkg` e `RELEASES`. O smoke Electron observou `ready`, criação do `BrowserWindow`, configuração do preload e tentativa de `loadURL`, mas não observou URL/título preenchidos, janela visível ou eventos do renderer; layout, popover interativo e chamada com par remoto não foram validados |
| Tipagem, testes e build | `npm run typecheck` e `npm test` (14 testes): aprovados; `npm run make` gerou os artefatos Windows x64 v0.2.4. `npx supabase test db` foi tentado, mas o daemon Docker não estava disponível (ECONNREFUSED em 127.0.0.1:54322); a asserção SQL adicionada não pôde ser executada localmente |
| Electron: zoom e layout | Runtime mediu `devicePixelRatio=1.25`; em viewport CSS 1139×668, as colunas mediram 216 / 677 / 246 px e `documentElement.scrollWidth` permaneceu em 1139 px |
| Release v0.2.4 e feed | Pública no commit `9680bed`; [Setup](https://github.com/victorhtanaka/Larp/releases/download/v0.2.4/Larp-0.2.4.Setup.exe) (166535680 B, SHA-256 `f829946ed04eba54274b8b8e1cb4a42ac61ff149a13bf5a8d968fef252eb5865`), [nupkg](https://github.com/victorhtanaka/Larp/releases/download/v0.2.4/Larp-0.2.4-full.nupkg) (165723735 B, SHA-256 `5e352fc7694ea816b65f1bbbd59cc499c8c2ee056e98ba9f92748174869f7161`) e `RELEASES` (75 B). O feed `update.electronjs.org`, consultado com `localVersion=0.2.3`, retornou o pacote v0.2.4 |
| Instalação, upgrade, Pesquisa e uninstall | Bloqueados: sem `WindowsSandbox.exe`, máquina física e sem elevação para criar perfil descartável; nenhum Setup ou updater foi executado |
| Supabase RLS, convites, leases e corrida | A migration remota `20261027014514_larp_user_profiles` está registrada. A consulta de catálogo confirmou RLS ativada/forçada, `anon` sem SELECT, leitura para `authenticated`, `user_id` sem UPDATE para `authenticated`, três políticas de dono/grupo e publicação Realtime. O arquivo pgTAP contém agora 15 asserções; a execução desta revisão ficou bloqueada pela indisponibilidade do daemon Docker. `npm run test:supabase` remoto não foi reexecutado; a última tentativa parou no primeiro login por Auth anônima desabilitada. Nenhum dado de perfil de teste foi gravado remotamente |
| Captura local de mídia | App empacotado 0.2.1 abriu com perfil temporário sem cloud; captura real de microfone e tela 1920×1080 passou pelos handlers Electron e foi encerrada. Fluxo de negação/reautorização e UI dependente de grupo não testados |
| Rede, WebRTC e TURN | Não validados: sem projeto staging e sem segundo PC. Um peer `disconnected` é descartado após 12 s; ICE `failed` tenta restart e expira após 20 s. Sem prova relay |
| Carga de seis participantes | Pendente: exige seis PCs; RTT e perda não aparecem nas métricas da interface |
| Workflow de release | [workflow_dispatch 40440207343](https://github.com/victorhtanaka/Larp/actions/runs/40440207343) passou build e publicação; release pública [v0.2.4](https://github.com/victorhtanaka/Larp/releases/tag/v0.2.4) no commit `9680bed` |

Configuração Supabase/credenciais TURN não estão incluídas no checkout. A migration `20261027014514_larp_user_profiles` já está registrada e presente remotamente; não foi necessário alterar DDL ou ampliar grants para corrigir o salvamento. Os logs confirmaram que o `upsert` tentava atualizar `user_id`, coluna intencionalmente sem permissão de UPDATE; `saveMyProfile` agora insere e, em conflito `23505`, atualiza somente `display_name` e `avatar_data`. O teste do serviço cobre esse fluxo com grants equivalentes, mas nenhum perfil de teste foi gravado remotamente e o salvamento interativo com a conta real não foi exercitado. O smoke test confirmou zoom e layout; builds e capturas locais não validam comunicação entre PCs, seleção de relay, reconexão ou capacidade máxima.
