# Larp

Aplicativo desktop Windows x64 para grupos privados de até seis pessoas. Electron + React + TypeScript; interface em português. O projeto inclui chat P2P assinado e persistido localmente, chamada de voz, compartilhamento de tela e áudio opcional do sistema. A comunicação entre PCs exige configuração de um projeto Supabase e, para conexões difíceis, credenciais de um provedor TURN gratuito.

O aplicativo não inclui credenciais de serviço, não habilita recursos pagos e não presume que STUN/TURN ou uma chamada funcionaram. Sem configuração externa, a interface não inventa grupos, perfis ou mensagens; o histórico só aparece quando há dados reais em cache.

## Interface

A interface usa fundo escuro (`#1A1A1A`) e texto claro (`#F0F0F0`), com teal (`#004D61`) e ruby (`#822659`) nos acentos e verde-floresta (`#3E5641`) nas ações principais. A organização mantém três áreas: grupos à esquerda, conversa no centro e detalhes/membros à direita. A referência ao Discord é visual; o Larp não cria canais, servidores públicos ou conteúdo fictício.


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
   - `supabase/migrations/20261026222746_fix_screen_share_lease_timestamp.sql`
4. O instalador Windows inclui `default-cloud-config.json` com a URL e a chave pública do projeto. Na primeira execução, ele copia esse arquivo para `app.getPath('userData')/config.json` somente se ainda não houver configuração; configurações existentes são preservadas.
   Para executar o projeto a partir do código-fonte, crie `config.json` em `app.getPath('userData')`:

   ```json
   {
     "supabaseUrl": "https://<project-ref>.supabase.co",
     "supabaseAnonKey": "<public-anon-key>"
   }
   ```

   Alternativamente, defina `LARP_SUPABASE_URL` e `LARP_SUPABASE_ANON_KEY`. Nunca use `service_role`, `sb_secret_...` ou chave administrativa no aplicativo; o cliente rejeita chaves com papel `service_role`.
5. Confirme que Auth, Postgres, Realtime privado e Edge Functions estão disponíveis no plano selecionado. A migração 0004 habilita eventos de alteração de membros para a tabela `larp_group_members`.

O Supabase guarda identidades públicas, grupos, membros e hashes de convites. Mensagens e histórico permanecem nos PCs. O app usa políticas RLS, convites de uso único por sete dias, limite atômico de seis membros e transferência de proprietário ao sair. A configuração e a identidade local não substituem políticas de cobrança: revalide os limites e termos do plano gratuito antes de publicar.

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
- Modos Movimento e Texto, codecs negociados (AV1/VP9/H.264/VP8 conforme suporte), orçamento total padrão de 20 Mb/s e teto de 8 Mb/s por conexão; métricas de resolução, FPS, codec, upload e caminho observado.
- Electron com `contextIsolation`, sandbox, Node desativado no renderer, permissões explícitas e IPC validado no processo principal.
- A nova logo aparece no cabeçalho do Larp e na janela do updater; o ícone Windows é incluído no executável e no Setup Squirrel.

1080p/60 FPS é uma meta mensurada, não uma garantia. O codec anunciado não prova aceleração por GPU. O modo de qualidade adapta envio por par para preservar voz e respeitar o orçamento configurado.

## Verificação local

```powershell
npm run typecheck
npm test
npm run make
```

Os testes locais cobrem persistência/migração SQLite, assinaturas e validação de protocolo, ordenação/deduplicação de mensagens e limites de qualidade de vídeo. `npm run make` gera `Setup.exe`, `.nupkg` e `RELEASES` do Squirrel em `out/make`. `npm run test:supabase` é um ensaio separado, somente para staging isolado.

O teste Supabase exige `LARP_TEST_SUPABASE_URL`, `LARP_TEST_SUPABASE_ANON_KEY` e `LARP_TEST_SUPABASE_ISOLATED=true`; recusa a URL de distribuição antes de criar clientes. Usa Auth anônimo e RPCs reais, incluindo aquisição exclusiva e liberação do lease de compartilhamento de tela. A verificação de expiração pausa para uma atualização dirigida no SQL Editor do staging. Nunca use credenciais `service_role` nem o projeto distribuído.

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

O feed público para `0.2.0/RELEASES` aponta para `Larp-0.2.1-full.nupkg`, hash `C616D3D5ABB0D79D48BD69DB2CF59931AD16D6C7`, tamanho `165719082` bytes, igual ao `RELEASES` da Release `v0.2.1`. Os Setup `0.2.0` e `0.2.1` baixados correspondem aos SHA-256 da API do GitHub. Nenhum Setup foi executado: Windows Sandbox e VM não estão disponíveis e a sessão não é elevada para criar um perfil local descartável; instalação, upgrade, Pesquisa e remoção continuam bloqueados.

O harness Supabase inclui a aquisição exclusiva do lease de tela; a proteção local recusou a URL de distribuição antes de qualquer requisição. A migration `20261026222746_fix_screen_share_lease_timestamp.sql` passou em PostgreSQL 17 temporário, verificando deadline `timestamptz`, exclusão mútua, substituição após expiração e exigência de associação. Os casos remotos não foram executados porque não há URL/chave de staging nem acesso ao SQL Editor; a migration ainda não foi aplicada a nenhum projeto remoto. Não houve escrita no projeto de distribuição.

O app 0.2.1 empacotado abriu com perfil temporário e cloud não configurado. Capturas reais de microfone e tela foram iniciadas e encerradas pelo renderer confiável e pelo handler de display do Electron. A tela de permissão negada/reautorização e a queda/restauração do estado cloud não foram exercitadas: falta staging para ativar um grupo e o app permanece em `not-configured`.

O workflow manual de release está configurado, mas o `workflow_dispatch` não foi executado: esta sessão não tem `gh`, `act` ou token GitHub disponível. Nenhuma Release nova foi criada. ICE relay, reconexão P2P e carga de seis participantes continuam pendentes; há somente um PC, e RTT/perda não são expostos pela interface atual.

Assinatura comercial do instalador continua fora do escopo. Consulte [`docs/architecture.md`](docs/architecture.md) para contratos, fronteiras e matriz de validação.
