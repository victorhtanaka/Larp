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

Cada participante estabelece no máximo cinco conexões WebRTC. A ordenação do identificador escolhe um único dono do RTCDataChannel por par; `ordered: true` e retransmissão confiável são exigidos. A negociação trata ofertas simultâneas por rollback/polite-peer, associa respostas a IDs de negociação, agrupa candidatos ICE, reinicia ICE e tenta reconectar pares desconectados. STUN padrão é `stun:stun.l.google.com:19302`; TURN é opcional e só chega ao cliente autenticado após validação de associação pela Edge Function.

A chamada entre duas aplicações só pode ser considerada aceita depois de configurar e exercitar duas identidades independentes e dois computadores; typecheck e testes locais não comprovam sinalização, firewall, NAT ou operação do provedor.

## Chat e histórico

O processo principal valida assinatura Ed25519 e participação antes de persistir. Mensagens possuem versão, UUID, grupo, autor, sequência por autor, texto limitado e horário. Mensagens P2P de saída são persistidas neste PC antes do envio. Envelopes de entrada são verificados antes de serem aceitos; IDs/sequências repetidos são idempotentes ou conflitos, e lacunas não são apresentadas fora de ordem.


O histórico ausente é solicitado em faixas e lotes limitados. Cada participante pode entregar cópias armazenadas localmente a outro participante; o receptor valida assinatura, grupo, sequência e duplicata antes de persistir. Confirmações também são assinadas e registradas localmente. Não existe recuperação garantida se todas as cópias locais forem perdidas, e um novo membro só recebe o histórico ainda disponível nos PCs conectados.

## Voz, tela e qualidade

A voz usa `getUserMedia`, Opus quando compatível, cancelamento de eco e supressão de ruído. O usuário seleciona microfone e saída, pode testar o microfone, silenciar entrada e silenciar reprodução. Captura de áudio só é permitida na janela principal e por solicitação explícita.

A captura de tela/janela exige seleção explícita no processo principal. Áudio de sistema começa desativado. Uma concessão SQL atômica permite uma tela por grupo; a reserva expira após 45 segundos sem renovação e é liberada ao parar ou sair. A captura e as faixas são encerradas no stop/fechamento. A visualização expande a transmissão dentro da janela maximizada, respeitando a área de trabalho do Windows; `Esc` retorna ao modo normal sem usar tela cheia exclusiva do sistema.

O controlador prefere AV1, VP9, H.264 e VP8 conforme os codecs anunciados; a presença de codec não prova aceleração por GPU. `contentHint` é `motion` ou `text`. O orçamento total padrão é 20 Mb/s, distribuído entre espectadores, com teto de 8 Mb/s por conexão. Parâmetros são ajustados pela rota e pressão observada do codificador; áudio não participa do orçamento de vídeo. A interface apresenta resolução, FPS, codec, upload e candidato direto/relay medidos. 1080p/60 é meta, não garantia.

TURN é entregue pela Edge Function `turn-credentials`, que valida JWT e associação e obtém `EXPRESSTURN_URLS`, `EXPRESSTURN_USERNAME` e `EXPRESSTURN_CREDENTIAL` do ambiente seguro. Credenciais não entram no executável ou repositório. Se a função não fornecer credenciais, o cliente informa indisponibilidade e mantém STUN; nunca ativa serviço pago. Se o provedor ainda emitir credenciais após esgotar a franquia de relay, o cliente não dispõe de API de quota: continua tentando STUN/TURN e reporta o caminho ICE observado ou indisponível.

## Segurança Electron

O `BrowserWindow` usa `contextIsolation`, sandbox e `nodeIntegration: false`; navegação externa e janelas novas são bloqueadas. O preload oferece métodos tipados e específicos. O processo principal valida janela e frame de origem, UUIDs, limites de texto/envelope, formato dos campos de perfil e conteúdo do avatar. O IPC de perfil não aceita ID de usuário; o serviço usa a identidade Supabase autenticada. Permissões de microfone e display são restritas à janela principal; a captura de tela exige seleção de uso único no processo principal. Ao fechar a janela, a limpeza da captura usa o ID salvo de `webContents` sem acessar o `BrowserWindow` destruído. Credenciais administrativas nunca são expostas ao renderer.

## Configuração e verificação

A implantação exige Auth anônimo Supabase, migrações ordenadas, chave pública do cliente e, opcionalmente, Edge Function TURN com segredos da conta gratuita. A migration `20261026230136_fix_screen_share_lease_timestamp.sql` corrige `expires_at` para usar uma expressão `timestamptz`; ela já foi aplicada ao projeto Supabase configurado no app. Outros projetos existentes precisam aplicá-la antes de reservar compartilhamento de tela. A migration `20261027014514_larp_user_profiles.sql` também deve estar aplicada antes de iniciar esta versão; ela já foi aplicada ao projeto configurado. Ver instruções em [`../README.md`](../README.md). A política de custo zero é operacional: verificar limites e ausência de upgrade/cobrança no painel de cada provedor.

Falhas após a verificação do atualizador fecham a tela de abertura e exibem a causa em uma caixa de erro nativa, em vez de deixar “Abrindo Larp” indefinidamente. Execuções a partir do código-fonte usam o perfil `Larp-dev`, isolado do banco da instalação. A migração SQLite v5 reconhece colunas de perfil existentes mesmo se `user_version` estiver em 4; ela preserva as colunas e dados ao restaurar a versão do esquema.

Verificação deste incremento em Windows x64: `npm run typecheck`, `npm test` (13 testes), `npm run package` e `npx supabase test db` (14 testes pgTAP) passaram. `npx supabase start` aplicou localmente todas as migrações. O ensaio `npm run test:supabase` não completou: a Auth anônima está desabilitada na configuração local; não há credenciais de staging para repetir o fluxo. A migration de perfil também foi aplicada remotamente e verificada por leitura dos metadados do schema; nenhum perfil ou dado de teste foi gravado remotamente. O workflow de release está configurado, mas nenhuma execução GitHub Actions foi disparada nesta validação.

| Ensaio | Estado |
|---|---|
| Tipagem, testes e build | `npm run typecheck`, `npm test` (13 testes) e `npm run package` Windows x64: aprovados; `npx supabase test db`: 14 testes pgTAP aprovados localmente. Sem prova de rede remota |
| Electron: zoom e layout | Runtime mediu `devicePixelRatio=1.25`; em viewport CSS 1139×668, as colunas mediram 216 / 677 / 246 px e `documentElement.scrollWidth` permaneceu em 1139 px |
| Release v0.2.3 e feed | Release pública no commit `4b778b3`; pacote `Larp-0.2.3-full.nupkg` (165723658 B, SHA-256 `08f852676e43e907030aab2f8ae315f502d632cc3f4137f48114352c6ab4a961`), Setup (166535680 B) e `RELEASES` (75 B; SHA-256 `3bb92a624f8f14494bd17265e441bcdce5e318fc2c72a99f3b3cae787ea2250e`). Manifest aponta ao pacote correto; `update.electronjs.org` ainda devolvia v0.2.2 às 02:29Z. O serviço usa cache Redis com TTL padrão de 15 min (`CACHE_TTL` pode ser sobrescrito) |
| Instalação, upgrade, Pesquisa e uninstall | Bloqueados: sem `WindowsSandbox.exe`, máquina física e sem elevação para criar perfil descartável; nenhum Setup ou updater foi executado |
| Supabase RLS, convites, leases e corrida | A migration remota `20261027014514_larp_user_profiles` está registrada. A consulta de catálogo confirmou RLS ativada/forçada, `anon` sem SELECT, leitura para `authenticated`, `user_id` sem UPDATE para `authenticated`, três políticas de dono/grupo e publicação Realtime. Os 14 testes pgTAP de perfil passaram no stack local. `npm run test:supabase` local parou no primeiro login porque a Auth anônima está desabilitada; nenhum grupo nem dado de teste foi criado. Não há credenciais de staging nem houve escrita de perfis remotamente |
| Captura local de mídia | App empacotado 0.2.1 abriu com perfil temporário sem cloud; captura real de microfone e tela 1920×1080 passou pelos handlers Electron e foi encerrada. Fluxo de negação/reautorização e UI dependente de grupo não testados |
| Rede, WebRTC e TURN | Não validados: sem projeto staging e sem segundo PC. Um peer `disconnected` é descartado após 12 s; ICE `failed` tenta restart e expira após 20 s. Sem prova relay |
| Carga de seis participantes | Pendente: exige seis PCs; RTT e perda não aparecem nas métricas da interface |
| Workflow de release | `workflow_dispatch` para `v0.2.3` passou build, staging e publicação; release pública verificada em [GitHub](https://github.com/victorhtanaka/Larp/releases/tag/v0.2.3) no commit `4b778b3` |

Configuração Supabase/credenciais TURN não estão incluídas no checkout. A validação anterior só aplicou a migration `20261026230136_fix_screen_share_lease_timestamp.sql`; nesta etapa, a migration `20261027014514_larp_user_profiles` foi aplicada ao projeto Supabase configurado e os metadados RLS/Realtime foram verificados somente por leitura. Nenhum perfil ou dado de teste foi gravado remotamente. O smoke test confirmou o zoom e o layout; o salvamento de perfil no app online ainda não foi exercitado. Builds e capturas locais não validam comunicação entre PCs, seleção de relay, reconexão ou capacidade máxima.
