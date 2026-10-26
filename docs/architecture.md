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
| Banco remoto | Identidade pública, grupo, associação, convites e concessão de tela; políticas RLS | `supabase/migrations/` |
| Edge Function | Credenciais TURN autorizadas por associação ativa | `supabase/functions/turn-credentials/` |

O SQLite fica em `app.getPath('userData')/larp.sqlite`. Mensagens não são enviadas ao banco Supabase. `identity.json` guarda a chave privada Ed25519 criptografada por `safeStorage`; `supabase-session.json` guarda a sessão anônima criptografada pelo mesmo mecanismo. Perder esses arquivos remove a identidade local; não há recuperação ou transferência entre PCs.

Na atualização do SQLite para a versão 4, o Larp apaga permanentemente as tabelas locais antigas `messages`, `participants` e `groups`, incluindo anotações salvas dentro dos grupos de demonstração; essas anotações não são exportadas. As tabelas de cache Supabase e os envelopes/ACKs P2P assinados permanecem intactos.

## Identidade, grupos e custo

A primeira execução cria uma chave Ed25519 local. A chave pública é registrada na sessão Supabase anônima. O cliente usa somente URL e chave pública `anon`/publishable; rejeita chave `service_role` e não embute segredos administrativos.

As migrações em ordem definem políticas RLS, funções transacionais e índices. Convites guardam somente hash, expiram em até sete dias e são de uso único. A aceitação bloqueia a linha do grupo e conta membros na mesma transação, impondo seis participantes mesmo sob entrada simultânea. Proprietários podem revogar convites/remover membros; ao sair, o proprietário é transferido ao membro mais antigo ou o grupo vazio é removido. A associação e a reserva de tela são verificadas pelo servidor.

O custo zero depende da escolha e configuração das contas do operador. O aplicativo não ativa planos pagos, não instala fallback pago e não tem mecanismo de cobrança. Supabase ou ExpressTURN podem suspender serviço por limite, inatividade ou mudança de termos. Operadores devem verificar que não há cartão, upgrade automático ou forma de cobrança antes da implantação. Quando Supabase não está disponível, o histórico local continua acessível; sem TURN, o aplicativo tenta conexão direta por STUN.

## Sinalização e malha P2P

O cliente autentica uma sessão anônima Supabase e usa canais Realtime privados `group:<uuid>`, autorizados por RLS para membros atuais. A sinalização é endereçada ao destinatário, versionada e assinada; envelopes inválidos, fora do grupo, enviados por usuário não associado ou acima do limite de tamanho são descartados. Candidatos ICE são enviados em lotes limitados.

A associação é atualizada por eventos Realtime da tabela `larp_group_members`; a migração 0004 habilita publicação e identidade completa de linha. Ao receber evento, cada cliente relê a associação pela função autenticada `list_group_members`, atualiza a malha e encerra conexões de membros removidos. Sinalização de um remetente ainda desconhecido causa uma releitura autorizada antes da entrega. O estado do canal não concede associação por si só.

Cada participante estabelece no máximo cinco conexões WebRTC. A ordenação do identificador escolhe um único dono do RTCDataChannel por par; `ordered: true` e retransmissão confiável são exigidos. A negociação trata ofertas simultâneas por rollback/polite-peer, associa respostas a IDs de negociação, agrupa candidatos ICE, reinicia ICE e tenta reconectar pares desconectados. STUN padrão é `stun:stun.l.google.com:19302`; TURN é opcional e só chega ao cliente autenticado após validação de associação pela Edge Function.

A chamada entre duas aplicações só pode ser considerada aceita depois de configurar e exercitar duas identidades independentes e dois computadores; typecheck e testes locais não comprovam sinalização, firewall, NAT ou operação do provedor.

## Chat e histórico

O processo principal valida assinatura Ed25519 e participação antes de persistir. Mensagens possuem versão, UUID, grupo, autor, sequência por autor, texto limitado e horário. Mensagens P2P de saída são persistidas neste PC antes do envio. Envelopes de entrada são verificados antes de serem aceitos; IDs/sequências repetidos são idempotentes ou conflitos, e lacunas não são apresentadas fora de ordem.


O histórico ausente é solicitado em faixas e lotes limitados. Cada participante pode entregar cópias armazenadas localmente a outro participante; o receptor valida assinatura, grupo, sequência e duplicata antes de persistir. Confirmações também são assinadas e registradas localmente. Não existe recuperação garantida se todas as cópias locais forem perdidas, e um novo membro só recebe o histórico ainda disponível nos PCs conectados.

## Voz, tela e qualidade

A voz usa `getUserMedia`, Opus quando compatível, cancelamento de eco e supressão de ruído. O usuário seleciona microfone e saída, pode testar o microfone, silenciar entrada e silenciar reprodução. Captura de áudio só é permitida na janela principal e por solicitação explícita.

A captura de tela/janela exige seleção explícita no processo principal. Áudio de sistema começa desativado. Uma concessão SQL atômica permite uma tela por grupo; a reserva expira após 45 segundos sem renovação e é liberada ao parar ou sair. A captura e as faixas são encerradas no stop/fechamento.

O controlador prefere AV1, VP9, H.264 e VP8 conforme os codecs anunciados; a presença de codec não prova aceleração por GPU. `contentHint` é `motion` ou `text`. O orçamento total padrão é 20 Mb/s, distribuído entre espectadores, com teto de 8 Mb/s por conexão. Parâmetros são ajustados pela rota e pressão observada do codificador; áudio não participa do orçamento de vídeo. A interface apresenta resolução, FPS, codec, upload e candidato direto/relay medidos. 1080p/60 é meta, não garantia.

TURN é entregue pela Edge Function `turn-credentials`, que valida JWT e associação e obtém `EXPRESSTURN_URLS`, `EXPRESSTURN_USERNAME` e `EXPRESSTURN_CREDENTIAL` do ambiente seguro. Credenciais não entram no executável ou repositório. Se a função não fornecer credenciais, o cliente informa indisponibilidade e mantém STUN; nunca ativa serviço pago. Se o provedor ainda emitir credenciais após esgotar a franquia de relay, o cliente não dispõe de API de quota: continua tentando STUN/TURN e reporta o caminho ICE observado ou indisponível.

## Segurança Electron

A janela usa `contextIsolation`, sandbox e `nodeIntegration: false`; navegação externa e janelas novas são bloqueadas. O preload oferece métodos tipados e específicos. O processo principal valida janela e frame de origem, UUIDs, limites de texto/envelope e assinaturas antes das operações. Permissões de microfone e display são restritas à janela principal; tela exige uma seleção de uso único no processo principal. Credenciais administrativas nunca são expostas ao renderer.

## Configuração e verificação

A implantação exige Auth anônimo Supabase, quatro migrações em ordem, chave pública do cliente e, opcionalmente, Edge Function TURN com segredos da conta gratuita. Ver instruções em [`../README.md`](../README.md). A política de custo zero é operacional: verificar limites e ausência de upgrade/cobrança no painel de cada provedor.

Verificação automatizada local: `npm run typecheck` e `npm test`. Os testes atuais exercitam migração e persistência SQLite, assinaturas/protocolo, ordem/deduplicação e orçamento de qualidade. `npm run make` gera o pacote Squirrel na plataforma atual. Assinatura comercial e atualização automática não estão incluídas.

| Ensaio | Estado |
|---|---|
| Tipagem e testes automatizados locais | Executáveis no repositório; não validam rede real |
| `npm run make` Windows x64 e execução do pacote unpacked | Gerado pelo maker Squirrel e iniciado em smoke test; instalação via `Setup.exe` não executada |
| Dois PCs na mesma rede e em redes distintas | Pendente de Supabase configurado e PCs independentes |
| Convites expirados/reutilizados, concorrência pela sexta vaga, RLS e remoção | Pendente de projeto Supabase configurado; as funções transacionais estão no SQL, mas não foram exercitadas em banco remoto |
| TURN forçado, falha de TURN e indisponibilidade Supabase | Pendente de credenciais e ensaio de rede |
| Permissões negadas, remoção de dispositivo e janela fechada | Pendente de ensaio em hardware Windows |
| Seis PCs, voz simultânea e cinco espectadores; CPU/GPU, FPS, resolução, upload, perda e atraso | Pendente; não declarar suporte validado a seis participantes antes do ensaio |

A configuração externa não está incluída no checkout. Logo, a comunicação real entre PCs e o desempenho máximo não podem ser declarados validados apenas por build/testes locais.
