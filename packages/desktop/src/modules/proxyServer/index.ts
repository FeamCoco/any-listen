import http from 'node:http'

import { logs } from '@any-listen/app/modules/logs'
import { initProxyServer as initProxyServerState, proxyRequest } from '@any-listen/app/modules/proxyServer'
import { PROXY_SERVER_PATH } from '@any-listen/common/constants'

import { appState } from '@/app'

// 显式绑定 IPv4 回环地址。
// 不使用 'localhost'：Node.js 17+ 在监听时会按系统 DNS 解析顺序（verbatim）解析主机名，
// 在部分机器上会解析为 IPv6 的 '::1'，导致服务只监听 IPv6 回环、向上层返回 http://[::1]:PORT，
// 在禁用或被策略拦截 IPv6 的环境（例如部分公司电脑）中无法访问。
// 也不使用 '0.0.0.0'：那会把服务暴露到局域网，改变「仅本机可访问」的语义。
const LISTEN_HOST = '127.0.0.1'
// 端口被占用（EADDRINUSE）时的最大递增重试次数
const MAX_PORT_RETRY = 10

let DEFAULT_PORT = 19500
const PROXY_PATH_PREFIX = `${PROXY_SERVER_PATH}/`
const createProxyServer = async (port: number) => {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Bad Request\n')
        return
      }
      const path = req.url.split('?')[0]
      if (path.startsWith(PROXY_PATH_PREFIX)) {
        const name = decodeURIComponent(path.replace(PROXY_PATH_PREFIX, ''))
        const result = await proxyRequest(name, req.headers)
        if (result) {
          for (const [key, value] of Object.entries(result.headers)) {
            if (!value) continue
            try {
              res.setHeader(key, value)
            } catch (e) {
              logs.ProxyService.logcat.warn(`invalid header: ${key}`, value, e)
            }
          }
          res.statusCode = result.statusCode
          if (result.body) {
            result.body.pipe(res)

            // 当客户端断开时，销毁所有流
            const cleanup = () => {
              if (result.body!.destroyed) return
              result.body!.destroy() // 中止上游请求
              res.removeListener('close', cleanup)
              req.removeListener('close', cleanup)
            }
            res.once('close', cleanup)
            req.once('close', cleanup)
          } else {
            res.end()
          }
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found\n')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('AnyListen Proxy Server\n')
    } catch (err) {
      logs.ProxyService.logcat.error(`proxyRequest error, path: ${req.url}, headers: ${JSON.stringify(req.headers)}`, err)
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal Server Error\n')
    }
  })
  server.listen(port, LISTEN_HOST)
  return new Promise<string>((resolve, reject) => {
    server.on('listening', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        // 监听地址已显式绑定到 IPv4 回环地址，正常情况下 family 为 'IPv4'，
        // 拼出的 host 必然是 '127.0.0.1'，即返回 `http://127.0.0.1:<port>`。
        // 此处的 IPv6 分支保留为防御性代码：一旦未来监听地址被改回 IPv6（如 '::1'），
        // 仍能拼出带方括号的合法 URL，避免回退成非法地址。
        const host = address.family == 'IPv6' ? `[${address.address}]` : address.address
        resolve(`http://${host}:${address.port}`)
      } else {
        reject(new Error('Failed to get server address'))
      }
    })
    server.on('error', (err) => {
      reject(err)
    })
  })
}

export const initProxyServer = async () => {
  let lastError: unknown
  // 端口被占用时自动递增端口重试。
  // 注意：createProxyServer 每次都会创建全新的 http.Server 实例并监听当前的 DEFAULT_PORT，
  // 不会复用已失败的 server 实例，因此重试过程不会出现「重复绑定同一个实例」的问题。
  // 原实现只在首个 catch 中重试一次，后续失败不会再被捕获（所谓「10 次重试」实际只生效一次），
  // 这里改为循环重试以符合注释所声明的语义。
  for (let retryCount = 0; retryCount <= MAX_PORT_RETRY; retryCount++) {
    try {
      const proxyHost = await createProxyServer(DEFAULT_PORT)
      console.log('Proxy server running at', proxyHost)
      void initProxyServerState(proxyHost, PROXY_SERVER_PATH, appState.cacheDataPath)
      return
    } catch (err) {
      lastError = err
      console.error(`Failed to start proxy server on ${DEFAULT_PORT} port`, err)
      DEFAULT_PORT++
    }
  }
  logs.ProxyService.logcat.error(`Failed to start proxy server after ${MAX_PORT_RETRY} retries`, lastError)
  throw new Error(`Failed to start proxy server after ${MAX_PORT_RETRY} retries`)
}
