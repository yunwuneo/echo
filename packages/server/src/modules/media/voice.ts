import { policies, quietAt } from '../autonomy/policy.js';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
import { command } from '../commands/index.js';
import { enqueueInTransaction } from '../runs/repository.js';
import { matchRevision, worldLock } from '../worlds/index.js';
import { storeMedia } from './index.js';
const fail = (message: string) => new AppError(409, 'voice_state', message);
export function playedWav(data: Buffer, playedMs: number) {
  if (
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw fail('Only PCM WAV supports exact played-part export');
  let at = 12,
    fmt: Buffer | undefined,
    audio: Buffer | undefined;
  while (at + 8 <= data.length) {
    const n = data.readUInt32LE(at + 4),
      tag = data.toString('ascii', at, at + 4);
    if (at + 8 + n > data.length) throw fail('Invalid WAV');
    if (tag === 'fmt ') fmt = data.subarray(at + 8, at + 8 + n);
    if (tag === 'data') audio = data.subarray(at + 8, at + 8 + n);
    at += 8 + n + (n % 2);
  }
  if (!fmt || fmt.length < 16 || fmt.readUInt16LE(0) !== 1 || !audio)
    throw fail('PCM WAV required');
  const rate = fmt.readUInt32LE(8),
    align = fmt.readUInt16LE(12);
  if (!rate || !align) throw fail('Invalid WAV rate');
  const length = Math.min(
    audio.length,
    Math.floor((playedMs * rate) / 1000 / align) * align,
  );
  if (!length) throw fail('No played audio to save');
  const header = Buffer.alloc(12 + 8 + fmt.length + 8);
  header.write('RIFF');
  header.writeUInt32LE(header.length + length - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(fmt.length, 16);
  fmt.copy(header, 20);
  header.write('data', 20 + fmt.length);
  header.writeUInt32LE(length, 24 + fmt.length);
  return Buffer.concat([header, audio.subarray(0, length)]);
}
export async function voiceCommand(db: pg.Pool, owner: string, input: any) {
  const p = input.payload;
  if (input.command === 'voiceLibrary')
    return {
      sessions: (
        await db.query(
          'SELECT * FROM voice_sessions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
      turns: (
        await db.query(
          'SELECT t.* FROM voice_turns t JOIN voice_sessions s ON s.id=t.session_id WHERE s.owner_id=$1 ORDER BY t.id LIMIT 100',
          [owner],
        )
      ).rows,
      invites: (
        await db.query(
          'SELECT * FROM voice_invites WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
    };
  return command(
    db,
    owner,
    input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (['startVoice', 'inviteVoice'].includes(input.command)) {
        const room = (
          await tx.query(
            'SELECT * FROM rooms WHERE owner_id=$1 AND id=$2 AND NOT deleted',
            [owner, p.room_id],
          )
        ).rows[0];
        if (
          !room ||
          !(
            await tx.query(
              'SELECT 1 FROM room_memberships WHERE room_id=$1 AND actor_id=$2 AND left_at IS NULL',
              [p.room_id, p.actor_id],
            )
          ).rowCount
        )
          throw fail('Voice member unavailable');
        if (input.command === 'inviteVoice') {
          const { g, p: policy } = await policies(tx, owner, room.world_id);
          if (
            quietAt(
              new Date(),
              g.timezone,
              policy.quiet_start,
              policy.quiet_end,
            )
          )
            throw fail('Quiet hours do not permit invitations');
          const previous = (
            await tx.query(
              "SELECT 1 FROM voice_invites WHERE owner_id=$1 AND actor_id=$2 AND created_at>now()-interval '2 hours'",
              [owner, p.actor_id],
            )
          ).rowCount;
          if (previous) throw fail('Invitation interval has not elapsed');
          return (
            await tx.query(
              'INSERT INTO voice_invites(owner_id,room_id,actor_id) VALUES($1,$2,$3) RETURNING *',
              [owner, p.room_id, p.actor_id],
            )
          ).rows[0];
        }
        if (p.invite_id) {
          const invite = (
            await tx.query(
              "UPDATE voice_invites SET state='accepted' WHERE id=$1 AND owner_id=$2 AND room_id=$3 AND actor_id=$4 AND state='pending' AND expires_at>now() RETURNING id",
              [p.invite_id, owner, p.room_id, p.actor_id],
            )
          ).rows[0];
          if (!invite) throw fail('Invitation expired or consumed');
        }
        return (
          await tx.query(
            'INSERT INTO voice_sessions(owner_id,room_id,actor_id,settings) VALUES($1,$2,$3,$4) RETURNING *',
            [owner, p.room_id, p.actor_id, JSON.stringify(p.settings)],
          )
        ).rows[0];
      }
      const session = (
        await tx.query(
          'SELECT s.*,r.world_id FROM voice_sessions s JOIN rooms r ON r.id=s.room_id WHERE s.id=$1 AND s.owner_id=$2 AND NOT r.deleted FOR UPDATE OF s',
          [p.session_id, owner],
        )
      ).rows[0];
      if (!session || session.state !== 'active')
        throw fail('Voice session is closed');
      await worldLock(tx, owner, session.world_id);
      if (input.command === 'closeVoice') {
        await tx.query(
          "UPDATE voice_sessions SET state='closed',revision=revision+1 WHERE id=$1",
          [session.id],
        );
        return { id: session.id, state: 'closed' };
      }
      let turn = (
        await tx.query(
          'SELECT * FROM voice_turns WHERE id=$1 AND session_id=$2 FOR UPDATE',
          [p.turn_id, session.id],
        )
      ).rows[0];
      if (input.command === 'voiceDraft') {
        if (turn) {
          matchRevision(turn, input.expected_revision);
          if (turn.state !== 'draft')
            throw fail('Sent utterance cannot be overwritten');
          return (
            await tx.query(
              'UPDATE voice_turns SET transcript=$2,revision=revision+1 WHERE id=$1 RETURNING *',
              [turn.id, p.text],
            )
          ).rows[0];
        }
        if (input.expected_revision !== 0) throw fail('Unknown utterance');
        return (
          await tx.query(
            'INSERT INTO voice_turns(id,session_id,transcript) VALUES($1,$2,$3) RETURNING *',
            [p.turn_id, session.id, p.text],
          )
        ).rows[0];
      }
      if (!turn) throw fail('Voice utterance missing');
      matchRevision(turn, input.expected_revision);
      if (input.command === 'acceptTranscription') {
        if (turn.state !== 'draft')
          throw fail('Late transcription cannot replace a sent utterance');
        const job = (
          await tx.query(
            "SELECT * FROM media_jobs WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND kind='stt' AND state='completed'",
            [p.job_id, owner, session.actor_id],
          )
        ).rows[0];
        if (!job) throw fail('Transcription unavailable');
        return (
          await tx.query(
            'UPDATE voice_turns SET transcript=$2,stt_job_id=$3,revision=revision+1 WHERE id=$1 RETURNING *',
            [turn.id, job.result.text, job.id],
          )
        ).rows[0];
      }
      if (input.command === 'finalizeVoice') {
        if (turn.state !== 'draft' || !turn.transcript.trim())
          throw fail('Utterance already sent or empty');
        const ack = await enqueueInTransaction(
          tx,
          owner,
          session.room_id,
          {
            client_command_id: turn.id,
            content: turn.transcript,
            addressed_actor_ids: [session.actor_id],
          },
          hash('voice:' + session.id + ':' + turn.id + ':' + turn.transcript),
        );
        await tx.query(
          "UPDATE voice_turns SET state='sent',run_id=$2,revision=revision+1 WHERE id=$1",
          [turn.id, ack.run_id],
        );
        return { ...turn, ...ack, state: 'sent', revision: turn.revision + 1 };
      }
      if (input.command === 'voicePlayback') {
        const job = (
          await tx.query(
            "SELECT * FROM media_jobs WHERE id=$1 AND owner_id=$2 AND actor_id=$3 AND kind='tts' AND state='completed'",
            [p.job_id, owner, session.actor_id],
          )
        ).rows[0];
        if (!job) throw fail('Speech audio unavailable');
        if (turn.tts_job_id && turn.tts_job_id !== job.id)
          throw fail('Playback source changed');
        await tx.query(
          'UPDATE voice_turns SET tts_job_id=$2,played_ms=greatest(played_ms,$3),revision=revision+1 WHERE id=$1',
          [turn.id, job.id, p.played_ms],
        );
        return {
          ...turn,
          id: turn.id,
          tts_job_id: job.id,
          revision: turn.revision + 1,
          played_ms: Math.max(turn.played_ms, p.played_ms),
        };
      }
      if (input.command === 'savePlayedAudio') {
        const job = (
          await tx.query(
            'SELECT * FROM media_jobs WHERE id=$1 AND owner_id=$2',
            [turn.tts_job_id, owner],
          )
        ).rows[0];
        const audio = (
          await tx.query('SELECT * FROM assets WHERE id=$1 AND owner_id=$2', [
            job?.result?.asset_id,
            owner,
          ])
        ).rows[0];
        if (!audio) throw fail('Played audio missing');
        const bytes = playedWav(audio.content, turn.played_ms);
        const id = await storeMedia(
          tx,
          owner,
          session.world_id,
          session.actor_id,
          bytes,
          'audio/wav',
        );
        await tx.query(
          'UPDATE voice_turns SET recording_id=$2,revision=revision+1 WHERE id=$1',
          [turn.id, id],
        );
        return {
          ...turn,
          asset_id: id,
          recording_id: id,
          revision: turn.revision + 1,
        };
      }
      throw fail('Unsupported voice action');
    },
  );
}
