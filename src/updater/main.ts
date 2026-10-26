import './styles.css';
import type { UpdaterViewState } from './contracts';
import larpWordmarkUrl from '../assets/larp-wordmark.png';


function getRequiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Elemento da janela de atualização não encontrado: ${selector}`);
  return element;
}

const title = getRequiredElement<HTMLHeadingElement>('#updater-title');
const description = getRequiredElement<HTMLParagraphElement>('#updater-description');
const progress = getRequiredElement<HTMLDivElement>('#updater-progress');
const actions = getRequiredElement<HTMLElement>('#updater-actions');
const retryButton = getRequiredElement<HTMLButtonElement>('#retry-update');
const continueButton = getRequiredElement<HTMLButtonElement>('#continue-update');
const versionLabel = getRequiredElement<HTMLElement>('#updater-version');
const logo = getRequiredElement<HTMLImageElement>('.brand-logo');
logo.src = larpWordmarkUrl;

function render(state: UpdaterViewState): void {
  versionLabel.textContent = `Versão instalada ${state.version}`;
  progress.hidden = true;
  actions.hidden = true;
  retryButton.hidden = true;
  continueButton.hidden = true;
  document.body.dataset.state = state.state;

  switch (state.state) {
    case 'checking':
      title.textContent = 'Verificando atualizações';
      description.textContent = 'Aguarde enquanto o Larp procura uma versão nova.';
      progress.hidden = false;
      break;
    case 'downloading':
      title.textContent = 'Atualização encontrada';
      description.textContent = 'Baixando a versão mais recente antes de abrir o Larp.';
      progress.hidden = false;
      break;
    case 'current':
      title.textContent = 'Larp está atualizado';
      description.textContent = 'Nenhuma atualização disponível.';
      break;
    case 'installing':
      title.textContent = 'Instalando atualização';
      description.textContent = 'O Larp será reiniciado com a nova versão.';
      progress.hidden = false;
      break;
    case 'opening':
      title.textContent = 'Abrindo Larp';
      description.textContent = 'A janela de atualização será fechada.';
      break;
    case 'error':
      title.textContent = 'Não foi possível verificar as atualizações';
      description.textContent = state.canRetry
        ? 'Confira sua conexão, tente novamente ou abra a versão já instalada.'
        : 'A solicitação demorou demais. Abrirei a versão instalada em instantes.';
      actions.hidden = false;
      retryButton.hidden = !state.canRetry;
      continueButton.hidden = false;
      break;
  }
}

retryButton.addEventListener('click', () => window.larpUpdater.retry());
continueButton.addEventListener('click', () => window.larpUpdater.continueWithoutUpdate());
const unsubscribe = window.larpUpdater.subscribe(render);
window.addEventListener('beforeunload', unsubscribe, { once: true });
