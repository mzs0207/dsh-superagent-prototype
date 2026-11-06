/** Password is sent only in the login request body, never a URL or browser storage. */
document.getElementById('login').addEventListener('submit', async event => {
  event.preventDefault()
  const input = document.getElementById('password'), button = document.getElementById('submit'), error = document.getElementById('error')
  button.disabled = true; error.hidden = true
  try {
    const response = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: input.value }).toString(), signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '登录失败')
    location.replace('/')
  } catch (failure) {
    error.textContent = failure instanceof TypeError || failure.name === 'TimeoutError' ? '无法连接电脑，请检查网络与只读服务。' : failure.message
    error.hidden = false
  } finally { input.value = ''; button.disabled = false }
})
