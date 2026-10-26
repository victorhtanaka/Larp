import { join } from 'node:path';
import type { IdentityManager } from './identity';
import { createIdentityManager } from './identity';
import { createCloudSetup, type SupabaseGroupsService } from './supabase-groups';
import type { CloudConnectionStatus, GroupSummary, PublicIdentity } from '../../shared/cloud-contracts';

export type CloudRuntimeStatus = CloudConnectionStatus;

export interface LarpRuntime {
  readonly identity: IdentityManager | null;
  readonly publicIdentity: PublicIdentity | null;
  getCloudStatus(): CloudRuntimeStatus;
  refreshCloud(): Promise<CloudRuntimeStatus>;
  requireCloud(): SupabaseGroupsService;
}

export async function createLarpRuntime(userDataPath: string): Promise<LarpRuntime> {
  let identity: IdentityManager | null = null;
  let publicIdentity: PublicIdentity | null = null;
  let identityError: string | undefined;
  try {
    identity = createIdentityManager(join(userDataPath, 'identity.json'));
    publicIdentity = await identity.getOrCreate();
  } catch (error) {
    identity = null;
    publicIdentity = null;
    identityError = error instanceof Error ? error.message : 'A identidade local não pôde ser protegida.';
  }

  let cloudService: SupabaseGroupsService | undefined;
  let cloudStatus: CloudRuntimeStatus = identityError
    ? { state: 'unavailable', detail: identityError, groups: [] }
    : { state: 'connecting', detail: 'Verificando a configuração de grupos…', groups: [] };
  let refreshInFlight: Promise<CloudRuntimeStatus> | undefined;

  const refreshCloud = (): Promise<CloudRuntimeStatus> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (!identity || !publicIdentity) return cloudStatus;
      try {
        if (!cloudService) {
          const setup = await createCloudSetup(
            join(userDataPath, 'config.json'),
            publicIdentity.publicKey,
            join(userDataPath, 'supabase-session.json'),
          );
          if (setup.status === 'not-configured') {
            const missing = setup.missing.map((key) => key === 'url' ? 'URL' : 'chave pública').join(' e ');
            cloudStatus = { state: 'not-configured', detail: `Configure ${missing} do Supabase.`, groups: [] };
            return cloudStatus;
          }
          cloudService = setup.groups;
        }
        const { userId } = await cloudService.signInAnonymously();
        const groups = await cloudService.listGroups();
        cloudStatus = { state: 'ready', detail: 'Sinalização autenticada disponível; nenhuma conexão P2P é presumida.', groups, userId };
      } catch (error) {
        cloudStatus = {
          state: 'unavailable',
          detail: error instanceof Error ? error.message : 'O serviço de grupos está indisponível.',
          groups: [],
        };
      }
      return cloudStatus;
    })().finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  };

  return {
    identity,
    publicIdentity,
    getCloudStatus: () => cloudStatus,
    refreshCloud,
    requireCloud() {
      if (cloudStatus.state !== 'ready' || !cloudService) {
        throw new Error(cloudStatus.state === 'not-configured' ? cloudStatus.detail : cloudStatus.detail || 'O serviço de grupos está indisponível.');
      }
      return cloudService;
    },
  };
}
