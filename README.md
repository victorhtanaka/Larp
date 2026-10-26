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

1080p/60 FPS é uma meta mensurada, não uma garantia. O codec anunciado não prova aceleração por GPU. O modo de qualidade adapta envio por par para preservar voz e respeitar o orçamento configurado.

## Verificação local

```powershell
npm run typecheck
npm test
npm run make
```

Os testes cobrem persistência/migração SQLite, assinaturas e validação de protocolo, ordenação/deduplicação de mensagens e limites de qualidade de vídeo. `npm run make` produz o instalador Squirrel para a plataforma atual; em Windows x64, verifique os artefatos `Setup.exe` e `.nupkg` gerados em `out/make`.

## Validação externa pendente

A validação local não equivale a um ensaio de rede real. Este checkout não contém projeto Supabase nem credenciais TURN; por isso, permanecem pendentes: o fluxo entre dois PCs, as políticas RLS implantadas, corrida pela sexta vaga, convite expirado/reutilizado, acesso de não membro, remoção entre clientes, STUN/TURN forçado, queda de rede, permissões de mídia em hardware real e carga de seis pessoas. Não declarar disponibilidade para seis participantes até testar seis PCs, voz simultânea e cinco espectadores, medindo CPU/GPU, upload, FPS, resolução, perda e atraso. O ensaio também deve confirmar no painel que nenhum limite ativa cobrança.

Assinatura comercial do instalador e atualização automática estão fora do escopo. Consulte [`docs/architecture.md`](docs/architecture.md) para contratos, fronteiras e matriz de validação.
