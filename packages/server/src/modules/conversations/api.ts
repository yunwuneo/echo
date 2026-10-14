import { storageCommand } from '../storage/index.js';
import { diagnosticsCommand } from '../storage/diagnostics.js';
import { hostCommand } from '../hosts/index.js';
import { localHostConversation } from '../hosts/conversations.js';
import {
  hostActions,
  storageActions,
} from '../../../../contracts/src/continuation.js';
import { miniappCommand } from '../miniapps/index.js';
import { platformCommand } from '../platform/index.js';
import { scheduleCommand, revealTriggerSecret } from '../schedules/index.js';
import { groupCommand } from '../groups/index.js';
import { voiceCommand } from '../media/voice.js';
import { mediaCommand } from '../media/index.js';
import { extensionCommand } from '../extensions/index.js';
import { bookCommand } from '../lorebooks/library.js';
import { memoryCommand } from '../memory/materials.js';
import {
  exportBackup,
  previewRestore,
  restoreBackup,
  dataHealth,
} from '../backups/index.js';
import {
  contentLibrary,
  createProject,
  documentDetails,
  saveDocument,
} from '../documents/index.js';
import { enableInternalTools } from '../documents/tools.js';
import { savePreset, saveProfile } from '../prompts/index.js';
import { command } from '../commands/index.js';
import { decrypt } from '../../security.js';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { AppError } from '../../security.js';
import { deletionPreview, deleteWithPreview } from '../identities/index.js';
import { probeProvider } from '../providers/probes.js';
import { regenerateMessage, deleteVersion } from './regeneration.js';
import { saveBehavior, behaviorDefaults } from './settings.js';
export async function milestone(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
  device?: string,
): Promise<any> {
  switch (input.action) {
    case 'feature':
      if (
        storageActions.some((a) => a.properties.command.const === input.command)
      )
        return storageCommand(db, config, owner, input);
      if (
        [
          'storageDiagnostics',
          'previewDiagnosticCleanup',
          'applyDiagnosticCleanup',
        ].includes(input.command)
      )
        return diagnosticsCommand(db, config, owner, input);
      if (
        ['receiveHostConversation', 'hostConversationResult'].includes(
          input.command,
        )
      )
        return localHostConversation(db, owner, input);
      if (hostActions.some((a) => a.properties.command.const === input.command))
        return hostCommand(db, owner, input);
      if (input.command === 'triggerSecret')
        return revealTriggerSecret(db, config, owner, input.payload.id);
      if (
        [
          'reportScheduleNotification',
          'scheduleLibrary',
          'saveSchedule',
          'pauseSchedule',
          'runOccurrence',
          'registerTrigger',
          'revokeTrigger',
          'registrationReceipt',
        ].includes(input.command)
      )
        return scheduleCommand(db, config, owner, input, device);
      if (
        [
          'platformLibrary',
          'todaySummary',
          'collaboratorContent',
          'reportCapability',
          'reportTodaySource',
          'setSystemPolicy',
          'createSystemAction',
          'decideSystemAction',
          'claimSystemAction',
          'completeSystemAction',
          'reconcileSystemAction',
          'receiveShareDraft',
          'sendShareDraft',
        ].includes(input.command)
      )
        return platformCommand(db, owner, input, device);
      if (
        [
          'appLibrary',
          'saveMiniApp',
          'importMiniApp',
          'setAppPermissions',
          'openRuntime',
          'grantSessionNetwork',
          'runtimeRequest',
          'commitRuntimeState',
          'closeRuntime',
          'runPython',
          'exportMiniApp',
          'previewResetState',
          'resetRuntimeState',
        ].includes(input.command)
      )
        return miniappCommand(db, config, owner, input);
      if (
        [
          'groupPolicy',
          'saveGroupPolicy',
          'setGroupMember',
          'sendPrivateLane',
          'previewDisband',
          'disbandGroup',
        ].includes(input.command)
      )
        return groupCommand(db, owner, input);
      if (
        [
          'voiceLibrary',
          'startVoice',
          'inviteVoice',
          'closeVoice',
          'voiceDraft',
          'acceptTranscription',
          'finalizeVoice',
          'voicePlayback',
          'savePlayedAudio',
        ].includes(input.command)
      )
        return voiceCommand(db, owner, input);
      if (
        [
          'mediaLibrary',
          'mediaConfig',
          'createMediaJob',
          'refreshMediaJob',
          'reconcileMediaJob',
          'prepareImage',
        ].includes(input.command)
      )
        return mediaCommand(db, config, owner, input);
      if (
        [
          'extensionLibrary',
          'prepareRemoteInstall',
          'cancelRemoteInstall',
          'previewConnectionImport',
          'applyConnectionImport',
          'previewExtension',
          'installExtension',
          'previewUninstall',
          'uninstallExtension',
          'setSkillMode',
          'useSkill',
          'sendWithSkill',
          'createAppFromExtension',
        ].includes(input.command)
      )
        return extensionCommand(db, owner, input);
      return [
        'bookLibrary',
        'createBook',
        'saveBookEntry',
        'bindBook',
      ].includes(input.command)
        ? bookCommand(db, owner, input)
        : memoryCommand(db, config, owner, input);
    case 'exportBackup':
      return exportBackup(db, input.password);
    case 'previewRestore':
      return previewRestore(db, config, owner, input.archive, input.password);
    case 'restoreBackup':
      return restoreBackup(
        db,
        config,
        owner,
        input.id,
        input.preview_token,
        input.keep_local,
      );
    case 'dataHealth':
      return dataHealth(db, owner);
    case 'contentLibrary':
      return contentLibrary(db, owner);
    case 'createProject':
      return createProject(db, owner, input);
    case 'documentDetails':
      return documentDetails(db, owner, input.id);
    case 'saveDocument':
      return saveDocument(db, owner, input);
    case 'enableInternalTools':
      return enableInternalTools(db, owner, input.operation_id);

    case 'promptLibrary':
      return {
        presets: (
          await db.query(
            'SELECT * FROM prompt_presets WHERE owner_id=$1 ORDER BY name,id',
            [owner],
          )
        ).rows,
        profiles: (
          await db.query(
            'SELECT * FROM prompt_profiles WHERE owner_id=$1 ORDER BY subject_id',
            [owner],
          )
        ).rows,
      };
    case 'savePreset':
      return savePreset(db, owner, input);
    case 'saveProfile':
      return saveProfile(db, owner, input);
    case 'clonePreset':
      return command(
        db,
        owner,
        'preset.clone',
        input.operation_id,
        input,
        async (tx) => {
          const p = (
            await tx.query(
              'SELECT data FROM prompt_presets WHERE owner_id=$1 AND id=$2',
              [owner, input.id],
            )
          ).rows[0];
          if (!p) throw new AppError(404, 'not_found', 'Preset not found');
          return (
            await tx.query(
              'INSERT INTO prompt_presets(owner_id,name,data) VALUES($1,$2,$3) RETURNING id,revision',
              [owner, input.name, JSON.stringify(p.data)],
            )
          ).rows[0];
        },
      );
    case 'recapHistory':
      return {
        items: (
          await db.query(
            'SELECT id,state,remaining,usage,error_code,payload_hash,created_at FROM time_recaps WHERE owner_id=$1 AND room_id=$2 ORDER BY created_at DESC LIMIT 100',
            [owner, input.id],
          )
        ).rows.map((r) => ({
          ...r,
          state: r.state === 'running' ? 'unknown' : r.state,
        })),
      };
    case 'requestSnapshots':
      return {
        items: (
          await db.query(
            'SELECT * FROM request_snapshots WHERE owner_id=$1 AND run_id=$2 ORDER BY attempt',
            [owner, input.id],
          )
        ).rows.map((r) => ({
          run_id: r.run_id,
          attempt: r.attempt,
          payload_hash: r.payload_hash,
          payload: JSON.parse(
            decrypt(
              r.payload,
              config,
              `${owner}:request:${r.run_id}:${r.attempt}`,
            ),
          ),
        })),
      };

    case 'deletionPreview':
      return deletionPreview(db, owner, input.resource, input.id);
    case 'deleteEntity':
      return deleteWithPreview(db, owner, input.id, {
        ...input,
        preview_token: input.context_token,
      });
    case 'probeProvider':
      return probeProvider(db, config, owner, input.id, input);
    case 'providerProbes':
      return {
        items: (
          await db.query(
            'SELECT * FROM provider_probes WHERE owner_id=$1 AND provider_id=$2 ORDER BY created_at DESC LIMIT 100',
            [owner, input.id],
          )
        ).rows.map((r) => ({
          ...r,
          state: r.state === 'running' ? 'unknown' : r.state,
        })),
      };
    case 'behaviorDefaults':
      return (
        (
          await db.query(
            'SELECT revision,behavior FROM conversation_defaults WHERE owner_id=$1',
            [owner],
          )
        ).rows[0] ?? { revision: 0, behavior: behaviorDefaults }
      );
    case 'saveBehavior':
      return saveBehavior(db, owner, input.id, input);
    case 'regenerateMessage':
      return regenerateMessage(db, owner, input.id, input);
    case 'deleteVersion':
      return deleteVersion(db, owner, input.id, input);
    default:
      throw new AppError(400, 'invalid_request', 'Unknown milestone action');
  }
}
