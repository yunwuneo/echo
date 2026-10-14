import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import { AppError } from '../../security.js';
// The macOS adapter uses the kernel sandbox; unsupported hosts fail closed.
// No subprocess inherits server credentials or unrestricted filesystem/network access.
export async function runPython(
  source: string,
  input: unknown,
  request: (url: string) => Promise<unknown>,
  timeout = 3000,
) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new AppError(
      503,
      'runtime_unavailable',
      'A supported isolated Python adapter is required',
    );
  const python = realpathSync(
    process.env.ECHO_PYTHON ??
      (existsSync('/opt/homebrew/bin/python3')
        ? '/opt/homebrew/bin/python3'
        : '/usr/bin/python3'),
  );
  const prefix = realpathSync(
    execFileSync(
      python,
      ['-I', '-B', '-c', 'import sys;print(sys.base_prefix)'],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 3000 },
    ).trim(),
  );
  const quote = (v: string) => JSON.stringify(v);
  const profile = `(version 1)(deny default)(allow file-read-metadata (literal "/opt") (literal "/opt/homebrew") (literal "/opt/homebrew/opt") (literal "/private") (literal "/private/tmp") (literal "/usr") (literal "/Library") (literal "/Library/Developer"))(allow process-exec (literal ${quote(python)}) (subpath ${quote(prefix)}))(allow file-map-executable (subpath "/System") (subpath "/private/preboot") (subpath "/private/var/db/dyld") (subpath "/usr/lib") (subpath "/opt/homebrew/Cellar"))(allow sysctl-read)(allow file-read* (literal "/") (subpath "/System") (subpath "/private/preboot") (subpath "/private/var/db/dyld") (subpath "/usr/lib") (subpath "/opt/homebrew/Cellar") (subpath "/Library/Developer/CommandLineTools") (subpath ${quote(prefix)}) (literal ${quote(python)}) (literal "/dev/urandom") (literal "/dev/null"))(allow file-write* (literal "/dev/null"))`;
  const id = randomUUID();
  const harness = String.raw`
import sys,json,ast,asyncio,resource,types
resource.setrlimit(resource.RLIMIT_CPU,(2,2))
resource.setrlimit(resource.RLIMIT_FSIZE,(0,0))
resource.setrlimit(resource.RLIMIT_NOFILE,(32,32))
if sys.platform.startswith("linux"):
 resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456))
 resource.setrlimit(resource.RLIMIT_NPROC,(0,0))
args=json.loads(sys.stdin.readline()); eid=args['id']; wire=sys.stdout
class Output:
 def write(self,s): wire.write(json.dumps({'id':eid,'type':'stdout','data':str(s)})+'\n');wire.flush()
 def flush(self): wire.flush()
sys.stdout=Output();sys.stderr=Output()
artifacts=[]
def output(value):
 if isinstance(value,str):
  if not value.strip(): raise ValueError('empty artifact')
 elif not isinstance(value,dict) or set(value)-{'content','title','kind','note'} or value.get('kind') not in ('code','tool') or not isinstance(value.get('content'),str) or not value['content'].strip(): raise ValueError('invalid artifact')
 artifacts.append(value)
async def request(url):
 rid=str(len(artifacts))+str(id(url))
 wire.write(json.dumps({'id':eid,'type':'request','request_id':rid,'url':url})+'\n');wire.flush()
 while True:
  reply=json.loads(sys.stdin.readline())
  if reply.get('id')!=eid or reply.get('request_id')!=rid: continue
  if 'error' in reply: raise RuntimeError(reply['error'])
  return reply['data']
app=types.SimpleNamespace(input=args['input'],output=output,request=request)
async def main():
 tree=ast.parse(args['source'])
 if tree.body and isinstance(tree.body[-1],ast.Expr): tree.body[-1]=ast.Return(tree.body[-1].value)
 fn=ast.AsyncFunctionDef(name='__run',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=tree.body or [ast.Pass()],decorator_list=[])
 module=ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[]));env={'app':app}
 exec(compile(module,'<miniapp>','exec'),env)
 return await env['__run']()
try:
 result=asyncio.run(main());wire.write(json.dumps({'id':eid,'type':'result','value':result,'artifacts':artifacts},default=str)+'\n');wire.flush()
except BaseException as e:
 wire.write(json.dumps({'id':eid,'type':'error','error':type(e).__name__+': '+str(e)})+'\n');wire.flush()
`;
  const linuxArgs = [
    '--unshare-all',
    '--new-session',
    '--die-with-parent',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--chdir',
    '/tmp',
  ];
  if (process.platform === 'linux') {
    if (!existsSync('/usr/bin/bwrap') || !python.startsWith('/usr/'))
      throw new AppError(
        503,
        'runtime_unavailable',
        'Linux requires bubblewrap, enabled user namespaces and Python under /usr',
      );
    for (const lib of ['/lib', '/lib64'])
      if (existsSync(lib)) linuxArgs.push('--ro-bind', lib, lib);
    linuxArgs.push(python, '-I', '-B', '-u', '-c', harness);
  }
  return new Promise<any>((resolve, reject) => {
    const child = spawn(
      process.platform === 'linux' ? '/usr/bin/bwrap' : '/usr/bin/sandbox-exec',
      process.platform === 'linux'
        ? linuxArgs
        : ['-p', profile, python, '-I', '-B', '-u', '-c', harness],
      {
        env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
        cwd: process.platform === 'linux' ? '/tmp' : '/private/tmp',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let done = false,
      buffer = '',
      bytes = 0,
      stdout = '',
      stderr = '',
      result: any;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(memoryWatch);
      child.kill('SIGKILL');
      error ? reject(error) : resolve({ ...result, stdout });
    };
    const memoryWatch = setInterval(() => {
      if (done || !child.pid) return;
      try {
        const rss = Number(
          execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], {
            encoding: 'utf8',
            timeout: 500,
          }),
        );
        if (rss > 131072)
          finish(
            new AppError(413, 'runtime_memory_limit', 'Memory limit exceeded'),
          );
      } catch {}
    }, 50);
    const timer = setTimeout(
      () => finish(new AppError(408, 'runtime_timeout', 'Execution timed out')),
      timeout,
    );
    child.on('error', finish);
    child.on('close', (code, signal) => {
      if (!done)
        finish(
          result
            ? undefined
            : new AppError(
                422,
                'runtime_failed',
                'Isolated execution failed (' +
                  code +
                  ',' +
                  signal +
                  '): ' +
                  stderr.slice(0, 1000),
              ),
        );
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      bytes += chunk.length;
      if (bytes > 65536)
        finish(
          new AppError(413, 'runtime_output_limit', 'Output limit exceeded'),
        );
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        finish(
          new AppError(413, 'runtime_output_limit', 'Output limit exceeded'),
        );
        return;
      }
      buffer += chunk.toString('utf8');
      let pos: number;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== id) continue;
        if (m.type === 'stdout') stdout += String(m.data);
        if (m.type === 'result') {
          if (
            !Array.isArray(m.artifacts) ||
            m.artifacts.some((a: any) =>
              typeof a === 'string'
                ? !a.trim()
                : !a ||
                  typeof a.content !== 'string' ||
                  !a.content.trim() ||
                  !['code', 'tool'].includes(a.kind) ||
                  Object.keys(a).some(
                    (k) => !['content', 'title', 'kind', 'note'].includes(k),
                  ),
            )
          ) {
            finish(new AppError(422, 'runtime_artifact', 'Invalid artifact'));
            return;
          }
          result = m;
        }
        if (m.type === 'error')
          finish(
            new AppError(422, 'runtime_failed', String(m.error).slice(0, 1000)),
          );
        if (m.type === 'request')
          void request(String(m.url)).then(
            (data) => {
              if (!done)
                child.stdin.write(
                  JSON.stringify({ id, request_id: m.request_id, data }) + '\n',
                );
            },
            () => {
              if (!done)
                child.stdin.write(
                  JSON.stringify({
                    id,
                    request_id: m.request_id,
                    error: 'network_denied',
                  }) + '\n',
                );
            },
          );
      }
    });
    child.stdin.write(JSON.stringify({ id, source, input }) + '\n');
  });
}
