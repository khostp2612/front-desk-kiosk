/* ========================================
   前台助手 - Service Worker
   Cache-First 离线策略
   ======================================== */

const CACHE_NAME = 'front-desk-kiosk-v3';

const PRECACHE_URLS = [
  '/',
  'index.html',
  'css/style.css',
  'js/storage.js',
  'js/knowledge.js',
  'js/llm.js',
  'js/voice.js',
  'data/faq-default.json',
  'manifest.json'
];

// 安装时预缓存核心文件
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// 激活时清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// 拦截请求：缓存优先，网络回退
self.addEventListener('fetch', (event) => {
  // 只缓存同源 GET 请求
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // 只缓存有效响应
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });

        return response;
      }).catch(() => {
        // 网络失败时尝试返回缓存中的 fallback
        return caches.match('index.html');
      });
    })
  );
});
