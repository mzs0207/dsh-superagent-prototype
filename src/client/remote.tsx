/** Password-only remote inventory management. Secrets live only in the mounted host editor, never in drafts or storage. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConnectionTest, HostKeyProbe, HostWrite, ManagedEnvironment, ManagedHost, ManagedProject, ManagedView } from '../remote-ops/managed-types.ts'
import { ApiError } from './api.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import type { T } from './text.ts'
import { Hint, Section } from './widgets.tsx'

type Commit = (write: () => Promise<ManagedView>, selectNew?: boolean) => Promise<boolean>
interface Actions { commit: Commit; disabled: boolean; conflict: () => void }
const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
// Never reflect server error bodies: even a faulty server must not echo a submitted password into the UI/toasts.
const failureText = (t: T, failure: unknown) => t(failure instanceof ApiError && failure.status === 409 ? 'remoteConflict'
  : failure instanceof ApiError && failure.status === 400 ? 'remoteInvalid'
    : failure instanceof ApiError && failure.missing ? 'remoteMissing' : 'remoteFailed')

function DeleteInline({ name, environment, disabled, remove }: {
  name: string; environment?: boolean; disabled: boolean; remove: () => Promise<boolean>
}) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  return open ? <div className="dt-remote-confirm" role="group" aria-label={t('remoteDeleteConfirm')}>
    <p className="dt-hint">{t(environment ? 'remoteDeleteEnvironmentHint' : 'remoteDeleteHostHint', { name })}</p>
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
  const { t, call } = usePanel()
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
  const { t, call } = usePanel()
  const [name, setName] = useState(host?.name ?? '')
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
    const body: HostWrite = { revision, name, host: address, port: Number(port), username, ...password ? { password } : {},
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
  const { t, call } = usePanel()
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
        if (failure instanceof ApiError && failure.status === 409) actions.conflict()
      }
    } finally { if (live.current) setPending(false); running.current = false }
  }
  const params = { environment, host: host.id, body: { revision } }
  const disabled = actions.disabled || pending
  return <article className="dt-card dt-remote-host" aria-label={host.name}>
    <div className="dt-card-head"><div className="dt-row-main"><h3 className="dt-block-title">{host.name}</h3>
      <span className="dt-hint dt-mono">{host.username}@{host.host}:{host.port}</span></div>
      <Tag>{t('remotePasswordAuth')}</Tag></div>
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

function EnvironmentPanel({ environment, revision, actions }: { environment: ManagedEnvironment; revision: number; actions: Actions }) {
  const { t, call } = usePanel()
  const [editor, setEditor] = useState<'environment' | 'new' | string>()
  const editingHost = environment.hosts.find(host => host.id === editor)
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
    {editor !== 'environment' && <Section title={t('remoteHosts')} count={environment.hosts.length}
      action={<Button size="sm" icon={<Icon name="plus" />} disabled={actions.disabled || editor !== undefined}
        onClick={() => setEditor('new')}>{t('remoteAddHost')}</Button>}>
      {editor === 'new' || editingHost ? <HostEditor key={editor} host={editingHost} environment={environment.id} revision={revision}
        actions={actions} onCancel={() => setEditor(undefined)} /> : environment.hosts.length ? environment.hosts.map(host =>
        <HostCard key={host.id} host={host} environment={environment.id} revision={revision} actions={actions}
          onEdit={() => setEditor(host.id)} />) : <Hint>{t('remoteNoHosts')}</Hint>}
    </Section>}
  </div>
}

export function RemotePage() {
  const { t, call } = usePanel()
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
      if (live.current) { setError(failureText(t, failure)); if (failure instanceof ApiError && failure.status === 409) setConflict(true) }
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
          <span>{item.name}</span><span className="dt-count">{item.hosts.length}</span>
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
