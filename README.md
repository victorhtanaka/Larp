# Larp

Aplicativo desktop Windows x64 para grupos privados de até seis pessoas. Electron + React + TypeScript; interface em português. O projeto inclui chat P2P assinado e persistido localmente, chamada de voz, compartilhamento de tela e áudio opcional do sistema. Perfis de exibição opcionais complementam os membros autorizados sem alterar mensagens assinadas. A comunicação entre PCs exige configuração de um projeto Supabase e, para conexões difíceis, credenciais de um provedor TURN gratuito.

O aplicativo não inclui credenciais de serviço, não habilita recursos pagos e não presume que STUN/TURN ou uma chamada funcionaram. Sem configuração externa, a interface não inventa grupos, perfis ou mensagens; o histórico só aparece quando há dados reais em cache.

## Interface

A interface usa zoom de página de 150% somente na janela principal e mantém os tamanhos atuais de janela. A paleta usa Steam (`#dddcde`), Valentine Heart (`#be779e`), Iron (`#5e5e5e`), Dark Charcoal (`#323232`), Eerie Black (`#1b1b1b`) e Existential Angst (`#0a0a0a`), sem tons adicionais. A organização mantém três áreas: grupos à esquerda, conversa no centro e detalhes/membros à direita. A referência ao Discord é visual; o Larp não cria canais, servidores públicos ou conteúdo fictício.

Perfis são opt-in: nome de até 32 caracteres e foto WebP quadrada de 128 × 128, até 48 KiB (imagem original até 8 MiB). O usuário só altera o próprio perfil; leitura fica limitada por RLS a si mesmo e a pessoas com quem compartilha ao menos um grupo privado. O cache local guarda os perfis dos membros dos grupos reais e continua somente leitura offline. Limpar o perfil restaura o identificador de PC; mensagens e assinaturas não mudam.


## Requisitos

- Windows x64.
- Node.js 22+ e npm.
- Para grupos entre PCs: projeto Supabase com Auth anônimo, banco e Realtime habilitados.
- Para relay: conta ExpressTURN configurada no plano gratuito, sem cobrança automática.

## Executar

```powershell
npm install
npm run start
```

Na primeira execução, o Larp cria uma identidade Ed25519 local e guarda a chave privada com `safeStorage` do Electron/Windows. O SQLite, o arquivo de configuração e a sessão Supabase protegida ficam em `app.getPath('userData')`:

- `larp.sqlite` — mensagens e metadados locais de grupos.
- `identity.json` — chave privada local protegida pelo Windows.
- `supabase-session.json` — sessão anônima criptografada com `safeStorage`.
- `config.json` — URL Supabase e chave pública de cliente.

Apagar ou perder a chave de identidade impede a recuperação da conta/grupos por este PC; será necessária outra identidade e um novo convite. Mensagens não têm cópia central: o histórico só pode ser recuperado de PCs que ainda conservem uma cópia.

## Configurar Supabase

1. Crie um projeto somente se a condição de custo total for zero. Confirme no painel que não há upgrade pago, cobrança automática ou cartão a ser usado em caso de limite. A política de cobrança é controlada pelo provedor, não pelo executável; planos gratuitos podem suspender serviço ao atingir limites ou por inatividade.
2. Habilite autenticação anônima no Supabase Auth.
3. Execute as migrações SQL, na ordem, no projeto:
   - `supabase/migrations/0001_private_groups.sql`
   - `supabase/migrations/0002_group_lifecycle.sql`
   - `supabase/migrations/0003_screen_share_leases.sql`
   - `supabase/migrations/0004_membership_realtime.sql`
   - `supabase/migrations/20261026230136_fix_screen_share_lease_timestamp.sql`
   - `supabase/migrations/20261027014514_larp_user_profiles.sql`
   A migration de perfis precisa estar aplicada antes de iniciar/atualizar o app contra esse projeto; a versão do cliente que usa perfis depende da tabela na listagem de membros.
4. O instalador Windows inclui `default-cloud-config.json` com a URL e a chave pública do projeto. Na primeira execução, ele copia esse arquivo para `app.getPath('userData')/config.json` somente se ainda não houver configuração; configurações existentes são preservadas.
   Para executar o projeto a partir do código-fonte, o Electron usa um perfil isolado `Larp-dev` em `app.getPath('appData')/Larp-dev`, evitando que migrações de desenvolvimento alterem o banco da instalação publicada. Crie `config.json` em `app.getPath('userData')`:

   ```json
   {
     "supabaseUrl": "https://<project-ref>.supabase.co",
     "supabaseAnonKey": "<public-anon-key>"
   }
   ```

   Alternativamente, defina `LARP_SUPABASE_URL` e `LARP_SUPABASE_ANON_KEY`. Nunca use `service_role`, `sb_secret_...` ou chave administrativa no aplicativo; o cliente rejeita chaves com papel `service_role`.
5. Confirme que Auth, Postgres, Realtime privado e Edge Functions estão disponíveis no plano selecionado. A migração 0004 habilita eventos de alteração de membros; `20261027004027` habilita atualização em tempo real dos perfis e usa RLS para filtrar visibilidade.

O Supabase guarda identidades públicas, grupos, membros, perfis opcionais, convites e concessões de tela. Perfis guardam `display_name` e um thumbnail WebP, sem campos de usuário arbitrários; nomes e fotos são visíveis apenas entre membros de grupos privados em comum. Mensagens e histórico permanecem nos PCs. O app usa políticas RLS, convites de uso único por sete dias, limite atômico de seis membros e transferência de proprietário ao sair. A configuração e a identidade local não substituem políticas de cobrança: revalide os limites e termos do plano gratuito antes de publicar.

## Configurar TURN gratuito (opcional)

O código usa `stun:stun.l.google.com:19302` para tentar conexão direta. Sem credenciais TURN, a malha continua apenas com STUN; redes que bloqueiam conexão direta podem não conectar.

Para fornecer relay, configure uma conta ExpressTURN somente no plano gratuito e confirme que não existe cobrança automática. Implante `supabase/functions/turn-credentials/index.ts` como Edge Function `turn-credentials`. Guarde os valores exclusivamente como secrets da função Supabase:

- `EXPRESSTURN_URLS` — uma a quatro URLs `turn:`/`turns:`, separadas por vírgula.
- `EXPRESSTURN_USERNAME`.
- `EXPRESSTURN_CREDENTIAL`.

A função valida a sessão autenticada e a participação no grupo antes de devolver credenciais TURN. Não coloque usuário/senha TURN no `config.json`, no repositório nem no executável. Para implantação, use a CLI oficial do Supabase e os segredos fornecidos pela conta gratuita, nunca uma chave de serviço do projeto no cliente.

Exemplo de implantação da função com a CLI oficial:

```powershell
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase functions deploy turn-credentials
```

Cadastre os três valores TURN na área de secrets das Edge Functions do Supabase; evite incluí-los no histórico do terminal.

Quando a função não fornece credenciais TURN (por configuração, limite ou suspensão), o Larp informa indisponibilidade e mantém STUN/conexão direta; não ativa provedor pago. Se o ExpressTURN continuar emitindo credenciais após esgotar a franquia de relay, o cliente não tem uma API de quota para detectar esse caso: continua tentando ICE com STUN e TURN, e as métricas mostram o caminho observado (ou indisponível). Bloqueios de rede também podem impedir ambos os caminhos.

## O que está implementado

- Identidade local Ed25519 e sessão anônima Supabase protegidas pelo armazenamento seguro do sistema.
- Vários grupos cadastrados, com um grupo conectado por vez; convites de uso único por sete dias, revogação, remoção de membros e saída com transferência do proprietário.
- Sinalização privada autenticada por membro, envelopes versionados e assinados, negociação WebRTC com ofertas simultâneas, lotes ICE e reinício/reconexão.
- Malha WebRTC para até cinco pares remotos por participante; canal de dados confiável e ordenado para chat e sincronização de histórico disponível.
- Persistência SQLite antes do envio, assinaturas Ed25519, deduplicação, verificação de sequência, confirmações locais e sincronização de lacunas por lotes. Não existe armazenamento central das mensagens.
- Microfone e saída selecionáveis, teste local, silenciar microfone/reprodução, Opus, cancelamento de eco e redução de ruído.
- Escolha explícita de monitor/janela; áudio do sistema desativado por padrão; reserva única de compartilhamento com expiração e liberação ao parar.
- Visualização da transmissão em tela cheia na janela, maximizando sem ocultar a barra de tarefas; `Esc` restaura o estado e o tamanho anteriores da janela.
- Modos Movimento e Texto, codecs negociados (AV1/VP9/H.264/VP8 conforme suporte), orçamento total padrão de 20 Mb/s e teto de 8 Mb/s por conexão; métricas de resolução, FPS, codec, upload e caminho observado.
- Perfis opcionais com nome e avatar WebP para membros autorizados; visibilidade compartilhada por grupo privado, armazenamento offline somente leitura e pseudônimo local restaurado ao limpar os campos.
- Electron com `contextIsolation`, sandbox, Node desativado no renderer, permissões explícitas e IPC validado no processo principal.
- A nova logo aparece no cabeçalho do Larp e na janela do updater; o ícone Windows é incluído no executável e no Setup Squirrel.

1080p/60 FPS é uma meta mensurada, não uma garantia. O codec anunciado não prova aceleração por GPU. O modo de qualidade adapta envio por par para preservar voz e respeitar o orçamento configurado.

## Verificação local

```powershell
npm run typecheck
npm test
npm run make
```

Os testes locais cobrem persistência/migração SQLite (incluindo cache de perfil v4→v5), validação de nome/avatar e formato IPC, assinaturas e validação de protocolo, ordenação/deduplicação de mensagens e limites de qualidade de vídeo. O teste SQL `supabase/tests/larp_user_profiles.test.sql` cobre RLS e visibilidade por associação; execute-o com `npx supabase start` e `npx supabase test db`. `npm run make` gera `Setup.exe`, `.nupkg` e `RELEASES` do Squirrel em `out/make`. `npm run test:supabase` é um ensaio separado, somente para staging isolado.

O teste Supabase exige `LARP_TEST_SUPABASE_URL`, `LARP_TEST_SUPABASE_ANON_KEY` e `LARP_TEST_SUPABASE_ISOLATED=true`; recusa a URL de distribuição antes de criar clientes. Usa Auth anônimo e RPCs reais para grupos/leases, além de testar criação e atualização do próprio perfil, leitura por membro compartilhado e negação para não membros ou após remoção da associação. A verificação de expiração pausa para uma atualização dirigida no SQL Editor do staging. Nunca use credenciais `service_role` nem o projeto distribuído.

## Atualizações automáticas e Pesquisa do Windows

Nas instalações Windows x64 feitas pelo `Setup.exe` Squirrel, o Larp abre uma janela compacta antes da interface principal e consulta [update.electronjs.org](https://update.electronjs.org) para `victorhtanaka/Larp`. Quando há uma versão mais nova, o Squirrel baixa o pacote, instala e reinicia o app; sem atualização, a janela fecha quando o Larp está pronto. Se a consulta falhar, é possível tentar novamente ou abrir a versão instalada; sem ação, o Larp abre a versão instalada após seis segundos. A primeira execução logo após a instalação ignora a consulta porque o Squirrel mantém os arquivos bloqueados durante a configuração.

O manipulador `electron-squirrel-startup` cria atalhos no menu Iniciar e na área de trabalho durante a instalação, e os remove na desinstalação. O atalho do menu Iniciar permite localizar o Larp pela Pesquisa do Windows.

Para publicar uma atualização:

1. Atualize `version` no `package.json` e no lockfile, faça commit e envie o código de release.
2. Crie e envie uma nova tag `vX.Y.Z` no commit que contém esse código. Não reescreva tags publicadas.
3. Aguarde o workflow `Release` disparado pela tag concluir build, typecheck e testes; esse evento nunca publica uma Release.
4. Para publicar, execute manualmente `workflow_dispatch` com `ref=vX.Y.Z` e `publish=true`. A publicação valida a tag e a versão do pacote; `publish=false` (padrão) só gera o artifact.

O updater exige Releases públicas com os artefatos Squirrel; o `Setup.exe` isolado não contém os dados usados para atualizar uma instalação existente. Instalações anteriores à versão `0.2.0` precisam instalar manualmente essa versão uma vez para receber atualizações futuras.

A atualização automática usa o `autoUpdater` integrado do Electron e é executada somente no app Windows empacotado. Assinatura comercial do instalador continua fora do escopo. Consulte [`docs/architecture.md`](docs/architecture.md) para contratos e limites.


## Validação externa e bloqueios

O feed atual `0.2.0/RELEASES` aponta para `Larp-0.2.1-full.nupkg`, hash `C616D3D5ABB0D79D48BD69DB2CF59931AD16D6C7` e tamanho `165719082` bytes; o arquivo `RELEASES` publicado em `v0.2.1` contém a mesma linha. Os Setup baixados em streaming coincidem com os digests da API GitHub: `0.2.0` (`166080000` bytes, SHA-256 `78f0d4c569246d313ec1e7415fc5f9ed62f2bafd30fe2b8e499a2115cab2c2f2`) e `0.2.1` (`166530560` bytes, SHA-256 `70e2d85b534ac1c5dc3b011390ac5406fd6c07289b7ca12a12303c4b9be2ea30`). Nenhum Setup ou updater foi executado: `WindowsSandbox.exe` está ausente, a máquina é um Dell G15 físico e a sessão não tem elevação para criar um perfil descartável; instalação, upgrade, Pesquisa e remoção continuam bloqueados.

O harness Supabase inclui aquisição exclusiva do lease de tela. A migration `20261026230136_fix_screen_share_lease_timestamp.sql` passou em PostgreSQL 17 temporário, cobrindo deadline `timestamptz`, exclusividade, substituição após expiração e exigência de associação; também foi aplicada ao projeto Supabase configurado no app. A inspeção SQL remota, somente leitura, confirmou que `acquire_group_share_lease` usa `lease_now` e mantém `expires_at` como `timestamptz`; `EXECUTE` continua permitido a `authenticated` e negado a `anon`. `npm run test:supabase` parou na preflight por falta de `LARP_TEST_SUPABASE_URL`; nenhum teste remoto de integração ou escrita de dados de teste ocorreu. A tentativa real de compartilhar ainda depende de retry no app autenticado.

O app 0.2.1 empacotado abriu com perfil temporário e cloud não configurado. Capturas reais de microfone e tela foram iniciadas e encerradas pelo renderer confiável e pelo handler de display do Electron. A tela de permissão negada/reautorização e a queda/restauração do estado cloud não foram exercitadas: falta staging para ativar um grupo e o app permanece em `not-configured`.

O workflow manual de release está configurado, mas o `workflow_dispatch` não foi executado: `gh` não está instalado e `GH_TOKEN`/`GITHUB_TOKEN` não estão definidos. Nenhuma Release nova foi criada. ICE relay, reconexão P2P e carga de seis participantes continuam pendentes; há somente um PC, e RTT/perda não são expostos pela interface atual.

Assinatura comercial do instalador continua fora do escopo. Consulte [`docs/architecture.md`](docs/architecture.md) para contratos, fronteiras e matriz de validação.
