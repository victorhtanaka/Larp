export type UpdaterViewState = {
  state: 'checking' | 'downloading' | 'current' | 'installing' | 'opening' | 'error';
  version: string;
  canRetry: boolean;
};

export interface UpdaterBridge {
  subscribe(onState: (state: UpdaterViewState) => void): () => void;
  retry(): void;
  continueWithoutUpdate(): void;
}
