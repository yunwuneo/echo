import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../../packages/server/src/config.js';
import {
  initializeOwner,
  createPairingCode,
  pair,
} from '../../packages/server/src/modules/pairing/auth.js';
import { createProvider } from '../../packages/server/src/modules/providers/index.js';
import { buildApp } from '../../packages/server/src/app.js';
import { terms } from '../../packages/server/src/modules/memory/retrieval.js';

// Refuse existing data; the caller must create a new, isolated benchmark volume.
export async function seed(db: pg.Pool, config: Config, modelURL: string) {
  if ((await db.query('SELECT 1 FROM owners')).rowCount)
    throw new Error('Benchmark requires an empty database');
  const owner = await initializeOwner(db, config);
  const sessions: Awaited<ReturnType<typeof pair>>[] = [];
  for (let i = 0; i < 2; i++)
    sessions.push(
      await pair(
        db,
        (await createPairingCode(db, owner)).code,
        `synthetic-client-${i}`,
        randomUUID(),
      ),
    );
  const provider = await createProvider(db, config, owner, {
    name: 'P6 合成模型',
    base_url: modelURL,
    api_key: 'synthetic-key',
    model: 'mock',
    context_window: 32768,
    max_output_tokens: 1024,
  });
  const app = await buildApp(db, config);
  async function create(path: string, payload: unknown) {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/' + path,
      headers: { authorization: `Bearer ${sessions[0]!.access_token}` },
      payload: payload as any,
    });
    if (r.statusCode !== 201)
      throw new Error(`Seed ${path}: ${r.statusCode} ${r.body}`);
    return r.json();
  }
  const character = await create('characters', {
    name: '林舟',
    description: '虚构星港领航员',
    personality: '谨慎',
    voice: '简短',
    scenario: '星港',
    example: '先核对航线。',
    greeting: '欢迎。',
  });
  const worlds = [];
  for (let w = 0; w < 10; w++) {
    const world = await create('worlds', {
      name: `合成星港${w}`,
      description: '合成容量测试世界',
      persona: { name: '航海员', description: '虚构玩家' },
    });
    const actors = [];
    for (let a = 0; a < 8; a++)
      actors.push(
        await create('actors', {
          world_id: world.id,
          template_id: character.id,
          template_revision: 1,
          name: `角色${a}`,
          participation: 50,
        }),
      );
    const ids = actors.map((a) => a.id);
    const room = await create('rooms', {
      world_id: world.id,
      name: '合成舰桥',
      kind: 'group',
      actor_ids: ids,
      provider_id: provider.id,
      max_replies: 3,
    });
    // Bulk history is valid completed dialogue, with the same per-message audience as live writes.
    await db.query(
      `INSERT INTO runs(id,owner_id,world_id,room_id,client_command_id,request_hash,user_message_id,reply_message_id,command_order,state)
      SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid(),'synthetic',gen_random_uuid(),gen_random_uuid(),n,'completed' FROM generate_series(1,5000) n`,
      [owner, world.id, room.id],
    );
    await db.query(
      `INSERT INTO messages(id,owner_id,room_id,run_id,sequence,role,content,status,actor_id,actor_name)
      SELECT user_message_id,owner_id,room_id,id,command_order*2-1,'user','合成航行记录：北塔灯塔正常，明晚九点集合。','completed',NULL,NULL FROM runs WHERE world_id=$1
      UNION ALL SELECT reply_message_id,owner_id,room_id,id,command_order*2,'assistant','收到，先核对航线再出发。','completed',$2::uuid,'角色0' FROM runs WHERE world_id=$1`,
      [world.id, ids[0]],
    );
    await db.query(
      'INSERT INTO message_audiences SELECT m.id,a FROM messages m CROSS JOIN unnest($2::uuid[]) a WHERE m.room_id=$1',
      [room.id, ids],
    );
    await db.query('UPDATE rooms SET next_sequence=10000 WHERE id=$1', [
      room.id,
    ]);
    await db.query(
      "UPDATE worlds SET next_command=5000,last_user_at=now()-interval '20 minutes' WHERE id=$1",
      [world.id],
    );
    const lore = {
      name: '合成航线',
      content: '星港飞船需要核对航线。',
      enabled: true,
      constant: false,
      keys: ['航线'],
      match_mode: 'keyword',
      case_sensitive: false,
      scan_depth: 8,
      priority: 10,
      insertion_slot: 'before_history',
      injection_depth: 0,
      audience_actor_ids: [],
      sticky_turns: 0,
      cooldown_turns: 0,
      delay_turns: 0,
    };
    await db.query(
      'INSERT INTO lore_entries(id,owner_id,world_id,data) SELECT gen_random_uuid(),$1,$2,$3 FROM generate_series(1,200)',
      [owner, world.id, lore],
    );
    await db.query(
      `INSERT INTO memories(id,owner_id,world_id,content,content_hash,topic,kind,status,audience_actor_ids,terms,manual)
      SELECT gen_random_uuid(),$1,$2,'北塔灯塔合成记录 '||n,'synthetic-'||n,'航线','statement','active',$3,$4,true FROM generate_series(1,1000) n`,
      [owner, world.id, ids, terms('北塔灯塔合成记录 航线')],
    );
    await db.query(
      'INSERT INTO memory_evidence SELECT m.id,r.user_message_id FROM memories m JOIN runs r ON r.world_id=m.world_id AND r.command_order=1 WHERE m.world_id=$1',
      [world.id],
    );
    await db.query(
      'UPDATE memory_settings SET enabled=true WHERE world_id=$1',
      [world.id],
    );
    await db.query(
      `INSERT INTO autonomy_policies(world_id,owner_id,enabled,memory,interaction,room_id,quiet_start,quiet_end,next_interaction_at)
      VALUES($1,$2,true,true,true,$3,'00:00','00:00',now()+interval '1 minute')
      ON CONFLICT(world_id) DO UPDATE SET enabled=true,memory=true,interaction=true,room_id=$3,quiet_start='00:00',quiet_end='00:00',next_interaction_at=now()+interval '1 minute'`,
      [world.id, owner, room.id],
    );
    worlds.push({ world, room, actors });
  }
  await db.query(
    `INSERT INTO autonomy_settings(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO UPDATE SET enabled=true`,
    [owner],
  );
  await db.query('ANALYZE');
  return { owner, sessions, provider, worlds, app };
}
