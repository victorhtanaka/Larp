import type { CloudConnectionStatus } from '../shared/cloud-contracts';

const CONNECTION_PRESENTATIONS: Record<CloudConnectionStatus['state'], { label: string; description: string }> = {
  connecting: {
    label: 'Conectando',
    description: 'Verificando o acesso aos grupos.',
  },
  'not-configured': {
    label: 'Configuração necessária',
    description: 'Peça ajuda a quem instalou o Larp para configurar o acesso aos grupos.',
  },
  unavailable: {
    label: 'Sem conexão',
    description: 'Não foi possível acessar os grupos. Verifique sua internet e tente novamente.',
  },
  ready: {
    label: 'Conectado',
    description: 'O acesso aos grupos está pronto neste computador.',
  },
};

export function connectionPresentation(status: CloudConnectionStatus): { label: string; description: string } {
  return CONNECTION_PRESENTATIONS[status.state];
}
