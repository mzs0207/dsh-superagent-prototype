/** Environment inventory management; password inputs are cleared on submission or unmount. */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ConnectionTest, HostKeyProbe, HostWrite, ManagedEnvironment, ManagedHost, ManagedProject, ManagedResource,
  ManagedView, ResourceAction, ResourceWrite } from './managed-types.ts'
import { Button, Icon, Input, Tag } from '../client/controls.tsx'
import { Field, Fields } from '../client/settings-kit.tsx'
import type { T } from '../client/text.ts'
import { Hint, Section } from '../client/widgets.tsx'
import { isWebsiteAddress, REMOTE_API, WEBSITE_SYSTEMS, type RemoteApi, type RemoteRequest, type WebsiteSystem } from './api.ts'

/** HTTP status only: never read or relay untrusted error bodies from a credential-submitting request. */
class RemoteRequestError extends Error { constructor(readonly status: number) { super('Environment management request failed') } }

async function call<K extends keyof RemoteApi>(route: K, ...[request]: {} extends RemoteRequest<K> ? [request?: RemoteRequest<K>] : [request: RemoteRequest<K>])
  : Promise<RemoteApi[K]['response']> {
  const [method, pattern] = route.split(' ') as [string, string]
  const values = (request ?? {}) as Record<string, unknown>
  const path = pattern.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(String(values[name])))
  const response = await fetch(`${REMOTE_API}${path}`, { method, headers: { 'x-orchestrator-request': '1',
    ...values.body === undefined ? {} : { 'content-type': 'application/json' } },
  ...values.body === undefined ? {} : { body: JSON.stringify(values.body) } })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    const missingRoute = response.status === 404 && !response.headers.get('content-type')?.startsWith('application/json')
    throw new RemoteRequestError(missingRoute ? 0 : response.status)
  }
  return response.json()
}

const Language = createContext<T>(key => key)

type Commit = (write: () => Promise<ManagedView>, selectNew?: boolean) => Promise<boolean>
interface Actions { commit: Commit; disabled: boolean; conflict: () => void }
const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
// Never reflect server error bodies: even a faulty server must not echo a submitted password into the UI/toasts.
const failureText = (t: T, failure: unknown) => t(failure instanceof RemoteRequestError && failure.status === 409 ? 'remoteConflict'
  : failure instanceof RemoteRequestError && failure.status === 400 ? 'remoteInvalid'
    : failure instanceof RemoteRequestError && failure.status === 404 ? 'remoteMissing' : 'remoteFailed')

function DeleteInline({ name, environment, disabled, remove }: {
  name: string; environment?: boolean; disabled: boolean; remove: () => Promise<boolean>
}) {
  const t = useContext(Language)
  const [open, setOpen] = useState(false)
  return open ? <div className="dt-remote-confirm" role="group" aria-label={t('remoteDeleteConfirm')}>
    <p className="dt-hint">{t(environment ? 'remoteDeleteEnvironmentHint' : 'remoteDeleteResourceHint', { name })}</p>
    <div className="dt-actions">
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => { void remove() }}>{t('remoteDeleteConfirm')}</Button>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(false)}>{t('cancel')}</Button>
    </div>
  </div> : <Button size="sm" icon={<Icon name="trash" size={14} />} disabled={disabled}
    onClick={() => setOpen(true)}>{t('remove')}</Button>
}

function EnvironmentEditor({ environment, revision, actions, onCancel }: {
  environment?: ManagedEnvironment; revision: number; actions: Actions; onCancel: () => void
}) {
  const t = useContext(Language)
  const [name, setName] = useState(environment?.name ?? '')
  const [aliases, setAliases] = useState(environment?.aliases.join('\n') ?? '')
  const [production, setProduction] = useState(environment?.production ?? false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (actions.disabled) return
    const body = { revision, name, aliases: lines(aliases), production }
    void actions.commit(() => environment ? call('PUT remote/environments/:environment', { environment: environment.id, body })
      : call('POST remote/environments', { body }), !environment)
  }
  return <form className="dt-form dt-card" aria-label={t(environment ? 'remoteEditEnvironment' : 'remoteAddEnvironment')} onSubmit={submit}>
    <Fields disabled={actions.disabled}>
      <h3 className="dt-block-title">{t(environment ? 'remoteEditEnvironment' : 'remoteAddEnvironment')}</h3>
      <Field label={t('remoteEnvironmentName')}><Input required maxLength={100} value={name}
        onChange={event => setName(event.target.value)} /></Field>
      <Field label={t('remoteAliases')} note={t('remoteOnePerLine')}><textarea className="dt-textarea" rows={2} value={aliases}
        onChange={event => setAliases(event.target.value)} /></Field>
      <label className="dt-remote-check"><input type="checkbox" checked={production}
        onChange={event => setProduction(event.target.checked)} />{t('remoteProduction')}</label>
      <div className="dt-actions"><Button type="submit" variant="primary">{t('save')}</Button>
        <Button onClick={onCancel}>{t('cancel')}</Button></div>
    </Fields>
  </form>
}

type ProjectDraft = Omit<ManagedProject, 'files' | 'profiles'> & { files: string; profiles: string }
const projectDraft = (project: ManagedProject): ProjectDraft => ({ ...project, files: project.files?.join('\n') ?? '',
  profiles: project.profiles?.join('\n') ?? '' })
const projectWrite = ({ files, profiles, projectName, ...project }: ProjectDraft): ManagedProject => ({ ...project,
  ...lines(files).length ? { files: lines(files) } : {}, ...projectName ? { projectName } : {},
  ...lines(profiles).length ? { profiles: lines(profiles) } : {} })

function HostEditor({ host, environment, revision, actions, onCancel }: {
  host?: ManagedHost; environment: string; revision: number; actions: Actions; onCancel: () => void
}) {
  const t = useContext(Language)
  const [name, setName] = useState(host?.name ?? '')
  const [notes, setNotes] = useState(host?.notes ?? '')
  const [address, setAddress] = useState(host?.host ?? '')
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [username, setUsername] = useState(host?.username ?? '')
  const [password, setPassword] = useState('')
  const [projects, setProjects] = useState(() => host?.projects.map(projectDraft) ?? [])
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const input = form.current?.querySelector<HTMLInputElement>('input[type="password"]')
    // Clear even a detached DOM input retained by an integration; React state is discarded on unmount.
    return () => { if (input) { input.value = ''; input.defaultValue = '' } }
  }, [])
  const cancel = () => { setPassword(''); onCancel() }
  const setProject = (index: number, change: Partial<ProjectDraft>) => setProjects(previous => previous.map((project, at) => at === index
    ? { ...project, ...change } : project))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (actions.disabled || (!host && !password)) return
    const body: HostWrite = { revision, name, host: address, port: Number(port), username, ...(notes || host?.notes ? { notes } : {}), ...password ? { password } : {},
      projects: projects.map(projectWrite) }
    // Do not retain a submitted credential while the request is in flight (or after failure).
    setPassword('')
    void actions.commit(() => host ? call('PUT remote/environments/:environment/hosts/:host', { environment, host: host.id, body })
      : call('POST remote/environments/:environment/hosts', { environment, body }))
  }
  return <form ref={form} className="dt-form dt-card" aria-label={t(host ? 'remoteEditHost' : 'remoteAddHost')} onSubmit={submit}
    autoComplete="off">
    <Fields disabled={actions.disabled}>
      <h3 className="dt-block-title">{t(host ? 'remoteEditHost' : 'remoteAddHost')}</h3>
      <Field label={t('remoteHostName')}><Input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field>
      <div className="dt-remote-endpoint">
        <Field label={t('remoteAddress')}><Input required maxLength={253} spellCheck={false} value={address}
          onChange={event => setAddress(event.target.value)} /></Field>
        <Field label={t('remotePort')}><Input required type="number" min={1} max={65535} step={1} value={port}
          onChange={event => setPort(event.target.value)} /></Field>
      </div>
      <Field label={t('remoteUsername')}><Input required maxLength={100} autoComplete="off" spellCheck={false} value={username}
        onChange={event => setUsername(event.target.value)} /></Field>
      <Field label={t('remotePassword')} note={t(host ? 'remotePasswordKeep' : 'remotePasswordRequired')}>
        <Input type="password" required={!host} maxLength={4096} autoComplete="new-password" value={password}
          onChange={event => setPassword(event.target.value)} /></Field>
      <Field label={t('remoteNotes')} note={t('remoteNotesHint')}><textarea className="dt-textarea" maxLength={2000}
        value={notes} onChange={event => setNotes(event.target.value)} /></Field>
      <Hint>{t('remotePasswordOnly')}</Hint>
      <Section title={t('remoteProjects')} count={projects.length} action={<Button size="sm" icon={<Icon name="plus" />}
        onClick={() => setProjects(previous => [...previous, { id: '', directory: '', files: '', profiles: '' }])}>{t('remoteAddProject')}</Button>}>
        <Hint>{t('remoteProjectsHint')}</Hint>
        {projects.map((project, index) => <div key={index} className="dt-card dt-remote-project">
          <div className="dt-subhead"><span>{t('remoteProjectNumber', { number: index + 1 })}</span>
            <Button size="sm" icon={<Icon name="trash" size={14} />} aria-label={t('remoteRemoveProject', { number: index + 1 })}
              onClick={() => setProjects(previous => previous.filter((_, at) => at !== index))}>{t('remove')}</Button></div>
          <div className="dt-grid3">
            <Field label={t('remoteProjectId')}><Input required value={project.id} onChange={event => setProject(index,
              { id: event.target.value })} /></Field>
            <Field label={t('remoteProjectDirectory')}><Input required value={project.directory} spellCheck={false}
              onChange={event => setProject(index, { directory: event.target.value })} /></Field>
            <Field label={t('remoteProjectFiles')} note={t('remoteOnePerLine')}><textarea className="dt-textarea" rows={2} value={project.files}
              onChange={event => setProject(index, { files: event.target.value })} /></Field>
          </div>
          <details><summary>{t('remoteAdvanced')}</summary><div className="dt-remote-advanced">
            <Field label={t('remoteProjectName')}><Input value={project.projectName ?? ''} onChange={event => setProject(index,
              { projectName: event.target.value })} /></Field>
            <Field label={t('remoteProjectProfiles')} note={t('remoteOnePerLine')}><textarea className="dt-textarea" rows={2}
              value={project.profiles} onChange={event => setProject(index, { profiles: event.target.value })} /></Field>
          </div></details>
        </div>)}
      </Section>
      <div className="dt-actions"><Button type="submit" variant="primary">{t('save')}</Button><Button onClick={cancel}>{t('cancel')}</Button></div>
    </Fields>
  </form>
}

function HostCard({ host, environment, revision, actions, onEdit }: {
  host: ManagedHost; environment: string; revision: number; actions: Actions; onEdit: () => void
}) {
  const t = useContext(Language)
  const [probe, setProbe] = useState<HostKeyProbe>()
  const [verified, setVerified] = useState(false)
  const [expired, setExpired] = useState(false)
  const [result, setResult] = useState<ConnectionTest>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const live = useRef(true)
  const running = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (!probe) return
    const remaining = Date.parse(probe.expiresAt) - Date.now()
    setExpired(!Number.isFinite(remaining) || remaining <= 0)
    if (!Number.isFinite(remaining) || remaining <= 0) return
    const timer = setTimeout(() => setExpired(true), remaining)
    return () => clearTimeout(timer)
  }, [probe])
  const run = async (request: () => Promise<void>) => {
    if (running.current || actions.disabled) return
    running.current = true; setPending(true); setError(undefined)
    try { await request() }
    catch (failure) {
      if (live.current) {
        setError(failureText(t, failure))
        if (failure instanceof RemoteRequestError && failure.status === 409) actions.conflict()
      }
    } finally { if (live.current) setPending(false); running.current = false }
  }
  const params = { environment, host: host.id, body: { revision } }
  const disabled = actions.disabled || pending
  return <article className="dt-card dt-remote-host" aria-label={host.name}>
    <div className="dt-card-head"><div className="dt-row-main"><h3 className="dt-block-title">{host.name}</h3>
      <span className="dt-hint dt-mono">{host.username}@{host.host}:{host.port}</span></div>
      <Tag>{t('remoteLinux')}</Tag></div>
    {host.notes && <Hint>{host.notes}</Hint>}
    <Hint>{t('remoteFingerprint')}</Hint>
    <code className="dt-mono">{host.hostKeyFingerprint ?? t('remoteUntrusted')}</code>
    <Fields disabled={disabled}>
      <div className="dt-actions">
        <Button size="sm" variant="outline" onClick={() => { void run(async () => {
          setProbe(undefined); setVerified(false); setResult(undefined)
          const value = await call('POST remote/environments/:environment/hosts/:host/probe', params)
          if (live.current) { setProbe(value); setExpired(Date.parse(value.expiresAt) <= Date.now()) }
        }) }}>{t('remoteProbe')}</Button>
        <Button size="sm" variant="outline" disabled={!host.hostKeyFingerprint} onClick={() => { void run(async () => {
          setResult(undefined)
          const value = await call('POST remote/environments/:environment/hosts/:host/test', params)
          if (live.current) setResult(value)
        }) }}>{t('remoteTest')}</Button>
        <Button size="sm" onClick={onEdit}>{t('remoteEditHost')}</Button>
        <DeleteInline name={host.name} disabled={disabled} remove={() => actions.commit(() => call(
          'DELETE remote/environments/:environment/hosts/:host', params))} />
      </div>
      {probe && <div className="dt-remote-trust" role="group" aria-label={t('remoteReviewFingerprint')}>
        <Hint>{t('remoteVerifyHint')}</Hint><code className="dt-mono">{probe.fingerprint}</code>
        <Hint>{t('remoteProbeExpires', { time: probe.expiresAt })}</Hint>
        {expired && <p className="dt-error" role="status">{t('remoteProbeExpired')}</p>}
        <label className="dt-remote-check"><input type="checkbox" disabled={expired} checked={verified}
          onChange={event => setVerified(event.target.checked)} />{t('remoteVerified')}</label>
        <Button size="sm" variant="primary" disabled={!verified || expired} onClick={() => {
          const deadline = Date.parse(probe.expiresAt)
          if (!verified || !Number.isFinite(deadline) || deadline <= Date.now()) { setExpired(true); return }
          void actions.commit(() => call('POST remote/environments/:environment/hosts/:host/trust', {
            environment, host: host.id, body: { revision, token: probe.token } }))
        }}>{t('remoteTrust')}</Button>
      </div>}
    </Fields>
    {pending && <p className="dt-hint" role="status">{t('remotePending')}</p>}
    {error && <p className="dt-error" role="alert">{error}</p>}
    {result && <p className={result.ok === true ? 'dt-hint' : 'dt-error'} role="status">{t(result.ok === true
      ? 'remoteTestOk' : 'remoteTestFailed', { duration: result.durationMs })}</p>}
    <Section title={t('remoteProjects')} count={host.projects.length}>
      {host.projects.length ? <ul className="dt-plain-list">{host.projects.map(project => <li key={project.id}>
        <strong>{project.label ?? project.id}</strong><span className="dt-mono"> · {project.directory}</span>
        {!!project.files?.length && <div className="dt-hint dt-mono">{project.files.join(' · ')}</div>}
      </li>)}</ul> : <Hint>{t('remoteNoProjects')}</Hint>}
    </Section>
  </article>
}

function ResourceEditor({ type, resource, environment, revision, actions, onCancel }: {
  type: ManagedResource['type']; resource?: ManagedResource; environment: string; revision: number; actions: Actions; onCancel: () => void
}) {
  const t = useContext(Language), form = useRef<HTMLFormElement>(null)
  const originFeedback = useId()
  const [invalidOrigin, setInvalidOrigin] = useState(false)
  const pg = resource?.type === 'postgresql' ? resource : undefined
  const web = resource?.type === 'website-account' ? resource : undefined
  const [system, setSystem] = useState<WebsiteSystem>(web?.system ?? 'oms')
  const [termsAccepted, setTermsAccepted] = useState(web?.communityTermsAccepted === true)
  useEffect(() => {
    const input = form.current?.querySelector<HTMLInputElement>('input[type="password"]')
    return () => { if (input) { input.value = ''; input.defaultValue = '' } }
  }, [])
  const title = resource ? 'remoteEditResource' : type === 'postgresql' ? 'remoteAddPostgres' : 'remoteAddWebsite'
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (actions.disabled) return
    if (type === 'website-account') {
      const origin = event.currentTarget.elements.namedItem('origin') as HTMLInputElement
      if (!isWebsiteAddress(origin.value, system)) {
        setInvalidOrigin(true)
        origin.focus()
        return
      }
    }
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '')
    const password = field('password')
    if (!resource && !password) return
    const input = event.currentTarget.elements.namedItem('password') as HTMLInputElement
    input.value = ''
    const fields = { revision, name: field('name'), username: field('username'), notes: field('notes'),
      allowWorker: data.has('allowWorker'), ...(password ? { password } : {}) }
    const body: ResourceWrite = type === 'postgresql'
      ? { ...fields, type, host: field('host'), port: Number(field('port')), database: field('database'), tls: data.has('tls'), ca: field('ca') }
      : { ...fields, type, system, origin: field('origin'),
          ...(system === 'community' && termsAccepted ? { communityTermsAccepted: true } : {}) }
    void actions.commit(() => resource ? call('PUT remote/environments/:environment/resources/:resource', { environment, resource: resource.id, body })
      : call('POST remote/environments/:environment/resources', { environment, body }))
  }
  return <form ref={form} className="dt-form dt-card" aria-label={t(title)} onSubmit={submit} autoComplete="off">
    <Fields disabled={actions.disabled}>
      <h3 className="dt-block-title">{t(title)} <Tag>{t(type === 'postgresql' ? 'remotePostgres' : 'remoteWebsite')}</Tag></h3>
      <Field label={t('remoteResourceName')}><Input name="name" required maxLength={100} defaultValue={resource?.name} /></Field>
      {type === 'postgresql' ? <>
        <div className="dt-remote-endpoint">
          <Field label={t('remoteAddress')}><Input name="host" required maxLength={253} defaultValue={pg?.host} /></Field>
          <Field label={t('remoteDbPort')}><Input name="port" type="number" required min={1} max={65535} defaultValue={pg?.port ?? 5432} /></Field>
        </div>
        <Field label={t('remoteDbName')}><Input name="database" required maxLength={100} defaultValue={pg?.database} /></Field>
        <Field label={t('remoteDbUsername')}><Input name="username" required maxLength={100} defaultValue={pg?.username} /></Field>
        <label className="dt-remote-check"><input type="checkbox" name="tls" defaultChecked={pg?.tls ?? false} />{t('remoteDbTls')}</label>
        <Hint>{t('remoteDbTlsHint')}</Hint>
        <Field label={t('remoteDbCa')}><textarea className="dt-textarea" name="ca" rows={3} maxLength={32768} defaultValue={pg?.ca} /></Field>
      </> : <>
        <Field label={t('remoteWebsiteSystem')}>
          <select name="system" className="dt-input" value={system} onChange={event => {
            const next = WEBSITE_SYSTEMS.find(value => value === event.target.value)
            if (next) setSystem(next)
            setInvalidOrigin(false)
            setTermsAccepted(false)
          }}>
            {WEBSITE_SYSTEMS.map(value => <option key={value} value={value}>{t(`remoteSite.${value}`)}</option>)}
          </select>
        </Field>
        <Field label={t('remoteWebOrigin')} note={<span id={originFeedback} role={invalidOrigin ? 'alert' : undefined}
          className={invalidOrigin ? 'dt-error' : undefined}>{t(system === 'zentao' ? 'remoteZentaoAddressHint' : 'remoteWebOriginHint')}</span>}>
          <Input name="origin" type="url" required maxLength={250} defaultValue={web?.origin} aria-describedby={originFeedback}
            aria-invalid={invalidOrigin || undefined} onChange={() => { setInvalidOrigin(false); setTermsAccepted(false) }} />
        </Field>
        <Field label={t(system === 'zentao' ? 'remoteWebsiteUsername' : 'remoteWebUser')}>
          <Input name="username" type={system === 'zentao' ? 'text' : 'email'} required maxLength={254} defaultValue={web?.username} />
        </Field>
        {system === 'community' && <label className="dt-remote-check"><input type="checkbox" checked={termsAccepted}
          onChange={event => setTermsAccepted(event.target.checked)} />{t('remoteCommunityTerms')}</label>}
      </>}
      <Field label={t('remoteResourcePassword')} note={t('remoteResourcePasswordRequired')}>
        <Input name="password" type="password" required={!resource} maxLength={4096} autoComplete="new-password" />
      </Field>
      <Field label={t('remoteNotes')} note={t('remoteNotesHint')}><textarea className="dt-textarea" name="notes" rows={3} maxLength={2000}
        defaultValue={resource?.notes} /></Field>
      <label className="dt-remote-check"><input type="checkbox" name="allowWorker" defaultChecked={resource?.allowWorker} />{t('remoteAllowWorker')}</label>
      <div className="dt-actions"><Button type="submit" variant="primary">{t('save')}</Button><Button onClick={onCancel}>{t('cancel')}</Button></div>
    </Fields>
  </form>
}

function ResourceCard({ resource, environment, revision, actions, onEdit }: {
  resource: ManagedResource; environment: ManagedEnvironment; revision: number; actions: Actions; onEdit: () => void
}) {
  const t = useContext(Language)
  const [pending, setPending] = useState<ResourceAction>()
  const [result, setResult] = useState<ConnectionTest>()
  const [error, setError] = useState<string>()
  const params = { environment: environment.id, resource: resource.id }
  const check = async (action: ResourceAction) => {
    if (pending || actions.disabled || environment.production) return
    setPending(action); setError(undefined); setResult(undefined)
    try { setResult(await call('POST remote/environments/:environment/resources/:resource/check', { ...params, body: { revision, action } })) }
    catch (failure) {
      setError(failureText(t, failure))
      if (failure instanceof RemoteRequestError && failure.status === 409) actions.conflict()
    } finally { setPending(undefined) }
  }
  const disabled = actions.disabled || pending !== undefined
  const termsRequired = resource.type === 'website-account' && resource.system === 'community' && !resource.communityTermsAccepted
  return <article className="dt-card dt-remote-host" aria-label={resource.name}>
    <div className="dt-card-head"><div className="dt-row-main"><h3 className="dt-block-title">{resource.name}</h3>
      <span className="dt-hint dt-mono">{resource.type === 'postgresql' ? `${resource.host}:${resource.port}/${resource.database}`
        : `${resource.origin} · ${resource.username}`}</span></div>
      <Tag>{resource.type === 'postgresql' ? t('remotePostgres') : t(`remoteSite.${resource.system}`)}</Tag></div>
    {resource.notes && <Hint>{resource.notes}</Hint>}
    <div className="dt-actions">
      {resource.type === 'postgresql' ? <Button size="sm" disabled={disabled || environment.production}
        onClick={() => { void check('database') }}>{t('remoteTest')}</Button> : <>
        <Button size="sm" disabled={disabled || environment.production || termsRequired} onClick={() => { void check('web') }}>{t('remoteTestWeb')}</Button>
        <Button size="sm" disabled={disabled || environment.production} onClick={() => { void check('api') }}>{t('remoteTestApi')}</Button>
      </>}
      <Button size="sm" disabled={disabled} onClick={onEdit}>{t('remoteEditResource')}</Button>
      <DeleteInline name={resource.name} disabled={disabled}
        remove={() => actions.commit(() => call('DELETE remote/environments/:environment/resources/:resource', { ...params, body: { revision } }))} />
    </div>
    {termsRequired && <Hint>{t('remoteCommunityTermsRequired')}</Hint>}
    {pending && <Hint>{t('remotePending')}</Hint>}
    {error && <p className="dt-error" role="alert">{error}</p>}
    {result && <p className={result.ok ? 'dt-hint' : 'dt-error'} role="status">{t(result.ok ? 'remoteTestOk' : 'remoteResourceTestFailed',
      { duration: result.durationMs })}</p>}
  </article>
}

function EnvironmentPanel({ environment, revision, actions }: { environment: ManagedEnvironment; revision: number; actions: Actions }) {
  const t = useContext(Language)
  const [editor, setEditor] = useState<'environment' | 'new' | string>()
  const editingHost = environment.hosts.find(host => host.id === editor)
  const resources = environment.resources ?? []
  const editingResource = resources.find(resource => resource.id === editor)
  const resourceType = editingResource?.type ?? (editor === 'postgresql' || editor === 'website-account' ? editor : undefined)
  return <div className="dt-remote-main">
    {editor === 'environment' ? <EnvironmentEditor environment={environment} revision={revision} actions={actions}
      onCancel={() => setEditor(undefined)} /> : <Section title={environment.name}
      badge={environment.production ? <Tag tone="warning">{t('remoteProduction')}</Tag> : undefined} action={<div className="dt-actions">
        <Button size="sm" disabled={actions.disabled} onClick={() => setEditor('environment')}>{t('remoteEditEnvironment')}</Button>
        <DeleteInline environment name={environment.name} disabled={actions.disabled} remove={() => actions.commit(() => call(
          'DELETE remote/environments/:environment', { environment: environment.id, body: { revision } }))} />
      </div>}>
      {!!environment.aliases.length && <Hint>{t('remoteAliases')}: {environment.aliases.join(' · ')}</Hint>}
    </Section>}
    {editor !== 'environment' && <Section title={t('remoteResources')} count={environment.hosts.length + resources.length}
      action={<div className="dt-actions">
        <Button size="sm" icon={<Icon name="plus" />} disabled={actions.disabled || editor !== undefined}
          onClick={() => setEditor('new')}>{t('remoteAddHost')}</Button>
        <Button size="sm" disabled={actions.disabled || editor !== undefined} onClick={() => setEditor('postgresql')}>{t('remoteAddPostgres')}</Button>
        <Button size="sm" disabled={actions.disabled || editor !== undefined} onClick={() => setEditor('website-account')}>{t('remoteAddWebsite')}</Button>
      </div>}>
      {editor === 'new' || editingHost ? <HostEditor key={editor} host={editingHost} environment={environment.id} revision={revision}
        actions={actions} onCancel={() => setEditor(undefined)} /> : resourceType
        ? <ResourceEditor key={editor} type={resourceType} resource={editingResource} environment={environment.id} revision={revision}
          actions={actions} onCancel={() => setEditor(undefined)} /> : <>
          {environment.hosts.map(host => <HostCard key={host.id} host={host} environment={environment.id} revision={revision}
            actions={actions} onEdit={() => setEditor(host.id)} />)}
          {resources.map(resource => <ResourceCard key={resource.id} resource={resource} environment={environment} revision={revision}
            actions={actions} onEdit={() => setEditor(resource.id)} />)}
          {!environment.hosts.length && !resources.length && <Hint>{t('remoteNoResources')}</Hint>}
        </>}
    </Section>}
  </div>
}

export function RemotePage({ t }: { t: T }) {
  return <Language.Provider value={t}><Inventory /></Language.Provider>
}

function Inventory() {
  const t = useContext(Language)
  const [view, setView] = useState<ManagedView>()
  const [selected, setSelected] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<string>()
  const [epoch, setEpoch] = useState(0)
  const live = useRef(true), request = useRef(0), writing = useRef(false)
  const reload = useCallback(async () => {
    const id = ++request.current
    setLoading(true); setError(undefined)
    try {
      const next = await call('GET remote')
      if (live.current && request.current === id) {
        setView(next); setConflict(false); setCreating(false); setEpoch(value => value + 1)
        setSelected(current => next.environments.some(item => item.id === current) ? current : next.environments[0]?.id)
      }
    } catch (failure) { if (live.current && request.current === id) setError(failureText(t, failure)) }
    finally { if (live.current && request.current === id) setLoading(false) }
  }, [call, t])
  useEffect(() => { live.current = true; void reload(); return () => { live.current = false; request.current++ } }, [reload])
  const commit: Commit = async (write, selectNew) => {
    if (writing.current || loading || conflict || !view) return false
    writing.current = true; setBusy(true); setError(undefined)
    const oldIds = view.environments.map(item => item.id)
    try {
      const next = await write()
      if (!live.current) return false
      setView(current => current && current.revision > next.revision ? current : next)
      setCreating(false)
      setSelected(current => selectNew ? next.environments.find(item => !oldIds.includes(item.id))?.id ?? current
        : next.environments.some(item => item.id === current) ? current : next.environments[0]?.id)
      return true
    } catch (failure) {
      if (live.current) { setError(failureText(t, failure)); if (failure instanceof RemoteRequestError && failure.status === 409) setConflict(true) }
      return false
    } finally { writing.current = false; if (live.current) setBusy(false) }
  }
  const environment = view?.environments.find(item => item.id === selected)
  const actions: Actions = { commit, disabled: busy || loading || conflict, conflict: () => setConflict(true) }
  return <Section title={t('tab.remote')} action={<Button variant="outline" size="sm" icon={<Icon name="refresh" />}
    disabled={busy || loading} onClick={() => { void reload() }}>{t('remoteRefresh')}</Button>}>
    <Hint>{t('remoteIntro')}</Hint>
    {error && <p className="dt-error" role="alert">{error}</p>}
    {conflict && <p className="dt-banner" role="status">{t('remoteConflict')}</p>}
    {loading && <p className="dt-hint" role="status">{t('loading')}</p>}
    {busy && <p className="dt-hint" role="status">{t('remotePending')}</p>}
    {view && <div className="dt-remote-layout">
      <nav className="dt-remote-nav" aria-label={t('remoteEnvironments')}>
        {view.environments.map(item => <button type="button" key={item.id} aria-label={item.name} disabled={busy || loading} className="dt-nav-item" aria-current={!creating
          && item.id === selected ? 'true' : undefined} onClick={() => { setCreating(false); setSelected(item.id); setEpoch(value => value + 1) }}>
          <span>{item.name}</span><span className="dt-count">{item.hosts.length + (item.resources?.length ?? 0)}</span>
        </button>)}
        <Button size="sm" icon={<Icon name="plus" />} disabled={actions.disabled} onClick={() => setCreating(true)}>
          {t('remoteAddEnvironment')}</Button>
      </nav>
      {creating ? <EnvironmentEditor key={`new:${view.revision}`} revision={view.revision} actions={actions} onCancel={() => setCreating(false)} />
        : environment ? <EnvironmentPanel key={`${environment.id}:${view.revision}:${epoch}`} environment={environment}
          revision={view.revision} actions={actions} /> : <Hint>{t('remoteNoEnvironments')}</Hint>}
    </div>}
  </Section>
}
