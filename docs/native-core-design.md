# Núcleo nativo Rust/napi-rs: arquitetura e baseline

**Estado:** o núcleo `napi-rs` está implementado e em cutover; build release e Forge/Squirrel Windows x64 verificados em diretório temporário. `npm test` passou 47/47, a suíte isolada de segurança passou 6/6 e os testes Rust passaram 39/39. Os smokes Electron confirmaram identidade preservada/reaberta, corrupção fail-closed e rejeição de chamadas de frame estrangeiro. Sem comparação de performance válida; backend Supabase local, VM de instalação/update e segundo dispositivo não estão disponíveis.

## Fronteiras e responsabilidades

- **Electron main (TypeScript):** continua dono de `BrowserWindow`, preload/IPC, política de navegação, permissões, `safeStorage`, seleção/captura de mídia, Squirrel/updater e integração Chromium. Não mover `getUserMedia`, `getDisplayMedia`, WebRTC, React ou rendering para Rust.
- **Preload/renderer:** contratos públicos `window.larp` e DTOs permanecem inalterados. Renderer não recebe Node, chave privada, token Supabase nem API N-API; não chama o addon diretamente.
- **Addon `native/larp-core`:** biblioteca `cdylib` Node-API via napi-rs, carregada somente pelo processo principal. Implementa identidade/Ed25519, projeção e validação de envelopes, persistência/ordenação/sync local, domínio cloud, filas/runtime e codecs de contratos privados. Dados de pares são revalidados antes de persistir; IPC não transforma entrada P2P em confiável.
- **Adaptador TS privado:** `src/main/native-core.ts` traduz os handlers IPC para comandos JSON tipados/versionados e respostas tipadas. A projeção não muda DTOs públicos; o host TypeScript mantém `safeStorage`, callbacks Electron e Supabase Realtime. Limites: envelope 64 KiB, conteúdo 8 KiB, lote sync até 6, faixa até 10.000; assinaturas usam bytes UTF-8 do JSON canônico conforme `src/shared/webrtc-protocol.ts`.
- **Cloud:** Rust possui operações de domínio e transporte REST/RPC/Auth/profile/TURN com TLS, timeout, limite de resposta, validação de URL e erros tipados; TypeScript mantém somente Supabase Realtime no processo principal. Usa apenas publishable/anon key. O transporte de produção nunca usa o servidor loopback do benchmark.
- **Armazenamento secreto:** `safeStorage` do Electron permanece como adaptador de plataforma. A chave privada não sai do processo principal nem é gravada em claro; o formato existente de `identity.json` e `supabase-session.json` é preservado. O addon recebe o material durante inicialização/assinatura e usa `zeroize` onde suportado. Falha de descriptografia/corrupção continua fail-closed.

## Concorrência, contratos e ciclo de vida

- Uma instância nativa por processo principal. SQLite tem um único escritor; uma fila limitada encaminha operações para um proprietário de conexão/estado, sem bloquear o event loop. Enfileiramento cheio retorna erro de backpressure tipado; filas/eventos repetíveis não podem crescer sem limite.
- Métodos N-API assíncronos devolvem Promise e entregam callbacks somente no event loop. Nunca chamar JS com mutex/transaction SQLite aberto. Fechar é idempotente, cancela/descarta resultados de épocas antigas e espera a fila parar antes de fechar o banco; callback tardio não recria recursos depois de close.
- O JSON interno é contrato privado, com discriminador e versão, campos exatos, limites de bytes e erros estáveis. Codec TS/Rust tem fixtures douradas para bytes assinados, envelopes, UUIDs, datas e valores nulos; não usar serialização genérica de map que altere os bytes canônicos.
- Grupos, sessão cloud, mudanças de membership e mídia recebem epochs/identificadores de operação. Respostas antigas não alteram grupo novo, UI fechada ou sessão revogada. N-API não mantém handle de renderer nem acessa BrowserWindow.

## Compatibilidade e cutover de dados

- O addon abre `app.getPath('userData')/larp.sqlite` no **schema v5 existente**, com WAL e foreign keys; não houve migração de schema. `peer_messages`, `peer_message_acks`, `cached_cloud_groups` e `cached_cloud_members` mantêm nomes, constraints, índices e significado. Rejeita `user_version > 5` e valida colunas esperadas antes de escrita.
- Preservar histórico e ACKs assinados, grupos/membros em cache, colunas anuláveis `display_name`/`avatar_data`, versão e conteúdo dos arquivos de identidade/sessão. Não regenerar identidade, truncar tabelas, nem reescrever JSON sem backup verificável e rollback. Migração futura usa snapshot temporário, valida contagens/constraints e só então troca atomicamente.
- Adquirir `app.requestSingleInstanceLock()` antes de abrir identidade/banco ou criar runtime. Durante cutover, remover todos os escritores TypeScript ao mesmo tempo que o addon assume o banco; nunca executar dois donos de SQLite concorrentes.
- Compatibilidade de protocolo foi exercitada por fixtures: Ed25519, canonicalização, campos aceitos, idempotência/conflito, validação de assinatura/grupo/transporte, ACK durável, faixa e ordenação. O envelope e seus limites não foram alterados.

## Dependências e build implementados

- Target `x86_64-pc-windows-msvc`, Node-API via napi-rs. `Cargo.lock` fixa `ed25519-dalek`, `rusqlite` com SQLite bundled, `reqwest`/rustls, `serde`, `tokio`, `url` e dependências de contrato/zeroize. A integração usa N-API, não ABI V8 específica do Electron.
- `rust-toolchain.toml` fixa Rust `1.100.0`, perfil minimal e target MSVC; `rustup default none` preserva o default global. O build release foi verificado com MSVC x64 `14.51.36231`/Visual Studio Community `18.7.1` e Windows SDK `10.0.26100.0`.
- Não há addon vazio, fallback TypeScript ou stub Rust. Os consumidores IPC foram migrados e as implementações TypeScript de domínio/persistência removidas após cobertura portável. `better-sqlite3` permanece em `devDependencies` para o benchmark histórico, mas não é empacotado em `app.asar`.

## Baseline TypeScript medido — Windows x64, 2026-11-13

`node tools/native-benchmark.cjs` iniciou 10 processos Electron isolados (5 execuções para cada escala), com Electron `45.0.0` e Node embarcado `24.22.0`. Cada execução gerou um SQLite v5 temporário, quatro autores Ed25519 sintéticos e uma lacuna conhecida por autor; escala lógica de 1.000/50.000 sequências resulta em 996/49.996 mensagens persistidas. O backend de fixtures escutou somente em `127.0.0.1`, recebeu 10 pedidos válidos e zero pedidos rejeitados. Variáveis de ambiente foram filtradas; perfil Electron, DB e fixtures foram criados em diretórios temporários e removidos ao terminar. Nenhum perfil real, config Supabase, token, conta remota, BrowserWindow ou dado de usuário foi usado.

Cada célula mostra mediana, mínimo–máximo e desvio-padrão populacional de cinco processos independentes. Tempos em ms; geração de fixture fica fora das medições de operação.

| Operação | Escala lógica 1k | Escala lógica 50k |
|---|---:|---:|
| Criar fixture assinada + persistir | 115,451 (110,530–169,660; σ 22,257) | 7.057,497 (6.792,202–7.259,205; σ 175,445) |
| Detectar prefixo contíguo em quatro autores | 0,458 (0,421–0,495; σ 0,024) | 12,615 (10,758–17,625; σ 2,708) |
| Ler histórico em cache (até 100 por autor) | 8,024 (7,708–11,398; σ 1,367) | 20,654 (18,137–29,267; σ 4,086) |
| Assinar uma mensagem Ed25519 | 0,089 (0,080–0,098; σ 0,006) | 0,139 (0,090–0,251; σ 0,054) |
| Validar/receber mensagem, persistir, ACK e pedir lacuna | 1,484 (1,397–1,787; σ 0,137) | 5,470 (3,461–6,182; σ 0,957) |

O worker usa o `MessageSynchronizer`, `createLarpDatabase`/store e validação/assinatura atuais dentro do processo principal Electron. `sendToPeer` é um coletor local; a lacuna e a geração de pedido são verificadas, mas não há WebRTC, renderer, Auth/RPC real, TURN, I/O de rede por mensagem nem concorrência de seis clientes. Os números são baseline parcial do caminho TypeScript, não benchmark ponta a ponta do produto. A comparação pareada final não é reportável: não existe fixture/API suportada para semear membros confiáveis e sessão no caminho Rust sem backend real ou mutação não suportada do SQLite. Nenhum ganho é afirmado.

## Critérios de aceite e limites verificados

1. Build release e Forge make para Windows x64 passaram; o artefato temporário contém um `larp_core.node`, um `app.asar`, `Setup.exe`, `.nupkg` e `RELEASES`. `better-sqlite3` não está em `app.asar`; instalação/update Squirrel em VM ainda não foi executada.
2. Testes Rust, `npm test`, typecheck e a suíte de segurança isolada passaram. Harness Electron exercitou `safeStorage`, identidade, reopen, corrupção fail-closed e rejeição de chamadas de frame estrangeiro.
3. Testes do addon real exercitam backpressure `queue-full`, reentrância de callback e `close`; testes Rust cobrem lifecycle/epochs. O smoke de Electron reportou identidade preservada e corrupção fail-closed.
4. Não há resultado de performance aceito: o benchmark nativo é `not-comparable` sem fixture confiável/seed de membros suportada. Não inferir ganho a partir de amostras vazias ou microbenchmarks.
5. `LARP-SEC-01` (lote vazio suprimindo retry) foi corrigido; a suíte isolada cobre retry limitado, resposta parcial e recuperação contínua. Outros gates do `docs/security-audit.md` não são fechados pela reescrita: integração Supabase requer Docker/CLI local; instalação Squirrel requer VM; paridade multi-device/multipeer/mídia requer peers reais.