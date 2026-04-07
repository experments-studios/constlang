(function(global) {
    'use strict';

    const CONFIG = {
        CACHE_MAX_SIZE: 49 * 1024 * 1024,
        FS_MAX_SIZE: 49 * 1024 * 1024 * 1024,
        CACHE_DB_NAME: 'MegaCacheDB',
        FS_DB_NAME: 'MegaFileSystemDB',
        CACHE_STORE: 'httpCache',
        FS_STORE: 'files',
        VERSION: 1
    };

    const Utils = {
        formatBytes: function(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },
        hash: function(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        },
        normalizePath: function(path) {
            return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
        },
        getDirName: function(path) {
            const normalized = Utils.normalizePath(path);
            const lastSlash = normalized.lastIndexOf('/');
            return lastSlash === -1 ? '' : normalized.substring(0, lastSlash);
        },
        getBaseName: function(path) {
            const normalized = Utils.normalizePath(path);
            const lastSlash = normalized.lastIndexOf('/');
            return lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1);
        }
    };

    // ==================== CACHE YÖNETİCİSİ ====================
    function CacheManager() {
        this.db = null;
        this.currentSize = 0;
        this.cacheMap = new Map();
        this.isInitialized = false;
    }

    CacheManager.prototype.init = function() {
        if (this.isInitialized) return Promise.resolve();
        var self = this;
        return new Promise(function(resolve, reject) {
            var request = indexedDB.open(CONFIG.CACHE_DB_NAME, CONFIG.VERSION);
            request.onerror = function() { reject(request.error); };
            request.onsuccess = function() {
                self.db = request.result;
                self.loadCacheInfo().then(function() {
                    self.isInitialized = true;
                    resolve();
                });
            };
            request.onupgradeneeded = function(event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(CONFIG.CACHE_STORE)) {
                    var store = db.createObjectStore(CONFIG.CACHE_STORE, { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                    store.createIndex('size', 'size', { unique: false });
                }
            };
        });
    };

    CacheManager.prototype.loadCacheInfo = function() {
        var self = this;
        return new Promise(function(resolve) {
            var transaction = self.db.transaction([CONFIG.CACHE_STORE], 'readonly');
            var store = transaction.objectStore(CONFIG.CACHE_STORE);
            var request = store.getAll();
            request.onsuccess = function() {
                var items = request.result || [];
                self.currentSize = 0;
                self.cacheMap.clear();
                items.forEach(function(item) {
                    self.cacheMap.set(item.url, item);
                    self.currentSize += item.size;
                });
                console.log('[MegaCache] Onbellek yuklendi: ' + items.length + ' dosya, ' + Utils.formatBytes(self.currentSize));
                resolve();
            };
            request.onerror = function() { resolve(); };
        });
    };

    CacheManager.prototype.cacheIndexAndDependencies = function(indexUrl) {
        var self = this;
        indexUrl = indexUrl || 'index.html';
        return this.init().then(function() {
            console.log('[MegaCache] Tarama baslatiliyor: ' + indexUrl);
            return self.fetchAndCache(indexUrl).then(function(indexContent) {
                if (!indexContent) throw new Error('Index yuklenemedi');
                var dependencies = self.extractDependencies(indexContent, indexUrl);
                console.log('[MegaCache] Bulunan bagimliliklar: ' + dependencies.length);
                var promiseChain = Promise.resolve();
                dependencies.forEach(function(url) {
                    promiseChain = promiseChain.then(function() {
                        if (self.currentSize >= CONFIG.CACHE_MAX_SIZE) {
                            console.log('[MegaCache] Limit doldu, durduruluyor.');
                            return Promise.resolve();
                        }
                        return self.fetchAndCache(url);
                    });
                });
                return promiseChain.then(function() {
                    console.log('[MegaCache] Tarama tamamlandi. Toplam: ' + Utils.formatBytes(self.currentSize));
                    return true;
                });
            });
        }).catch(function(error) {
            console.error('[MegaCache] Hata:', error);
            return false;
        });
    };

    CacheManager.prototype.extractDependencies = function(html, baseUrl) {
        var dependencies = new Set();
        var base = new URL(baseUrl, window.location.href).href.replace(/\/[^\/]*$/, '/');
        var match;
        var cssRegex = /href=["']([^"']+\.css)["']/gi;
        while ((match = cssRegex.exec(html)) !== null) {
            dependencies.add(new URL(match[1], base).href);
        }
        var jsRegex = /src=["']([^"']+\.js)["']/gi;
        while ((match = jsRegex.exec(html)) !== null) {
            dependencies.add(new URL(match[1], base).href);
        }
        var imgRegex = /src=["']([^"']+\.(png|jpg|jpeg|gif|svg|webp))["']/gi;
        while ((match = imgRegex.exec(html)) !== null) {
            dependencies.add(new URL(match[1], base).href);
        }
        return Array.from(dependencies);
    };

    CacheManager.prototype.fetchAndCache = function(url) {
        var self = this;
        return fetch(url, { method: 'GET', cache: 'no-store' })
            .then(function(response) {
                if (!response.ok) return null;
                return response.text();
            })
            .then(function(content) {
                if (!content) return null;
                var newHash = Utils.hash(content);
                var size = new Blob([content]).size;
                if (self.currentSize + size > CONFIG.CACHE_MAX_SIZE) {
                    console.log('[MegaCache] Yer kalmadi, atlaniyor: ' + url);
                    return content;
                }
                return self.saveToCache(url, content, size, newHash).then(function() {
                    console.log('[MegaCache] Onbellege alindi: ' + url + ' (' + Utils.formatBytes(size) + ')');
                    return content;
                });
            })
            .catch(function(error) {
                console.warn('[MegaCache] Hata (' + url + '):', error);
                return null;
            });
    };

    CacheManager.prototype.saveToCache = function(url, content, size, hash) {
        var self = this;
        return new Promise(function(resolve, reject) {
            var transaction = self.db.transaction([CONFIG.CACHE_STORE], 'readwrite');
            var store = transaction.objectStore(CONFIG.CACHE_STORE);
            var data = { url: url, content: content, size: size, hash: hash, timestamp: Date.now() };
            var request = store.put(data);
            request.onsuccess = function() {
                self.cacheMap.set(url, data);
                self.currentSize += size;
                resolve();
            };
            request.onerror = function() { reject(request.error); };
        });
    };

    CacheManager.prototype.loadFromCacheFirst = function(url) {
        var self = this;
        return this.init().then(function() {
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.CACHE_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.CACHE_STORE);
                var request = store.get(url);
                request.onsuccess = function() {
                    var cached = request.result;
                    if (!cached) {
                        console.log('[MegaCache] Onbellekte yok, sunucudan cekiliyor: ' + url);
                        fetch(url).then(resolve).catch(reject);
                        return;
                    }
                    console.log('[MegaCache] Onbellekten yuklendi: ' + url);
                    self.checkForUpdate(url, cached.hash).then(function(updated) {
                        if (updated) {
                            window.dispatchEvent(new CustomEvent('megacache-update', { detail: { url: url } }));
                        }
                    });
                    var blob = new Blob([cached.content], { type: self.getContentType(url) });
                    resolve(new Response(blob));
                };
                request.onerror = function() { reject(request.error); };
            });
        });
    };

    CacheManager.prototype.checkForUpdate = function(url, oldHash) {
        var self = this;
        return fetch(url, { method: 'GET', cache: 'no-store' })
            .then(function(response) {
                if (!response.ok) return false;
                return response.text();
            })
            .then(function(content) {
                if (!content) return false;
                var newHash = Utils.hash(content);
                if (oldHash !== newHash) {
                    if (url.endsWith('index.html') || url.endsWith('.html')) {
                        return self.cacheIndexAndDependencies(url).then(function() { return true; });
                    } else {
                        var size = new Blob([content]).size;
                        return self.saveToCache(url, content, size, newHash).then(function() { return true; });
                    }
                }
                return false;
            })
            .catch(function() { return false; });
    };

    CacheManager.prototype.getContentType = function(url) {
        var ext = url.split('.').pop().toLowerCase();
        var types = {
            'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript',
            'json': 'application/json', 'png': 'image/png', 'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg', 'gif': 'image/gif', 'svg': 'image/svg+xml'
        };
        return types[ext] || 'text/plain';
    };

    CacheManager.prototype.clearCache = function() {
        var self = this;
        return new Promise(function(resolve) {
            var transaction = self.db.transaction([CONFIG.CACHE_STORE], 'readwrite');
            var store = transaction.objectStore(CONFIG.CACHE_STORE);
            var request = store.clear();
            request.onsuccess = function() {
                self.cacheMap.clear();
                self.currentSize = 0;
                console.log('[MegaCache] Onbellek temizlendi');
                resolve();
            };
        });
    };

    CacheManager.prototype.getStats = function() {
        return {
            used: this.currentSize,
            max: CONFIG.CACHE_MAX_SIZE,
            files: this.cacheMap.size,
            percent: ((this.currentSize / CONFIG.CACHE_MAX_SIZE) * 100).toFixed(2)
        };
    };

    // ==================== DOSYA SİSTEMİ (49GB) ====================
    function FileSystem() {
        this.db = null;
        this.currentSize = 0;
        this.isInitialized = false;
        this.openFiles = new Map();
        this.openFolders = new Map();
    }

    FileSystem.prototype.init = function() {
        if (this.isInitialized) return Promise.resolve();
        var self = this;
        return new Promise(function(resolve, reject) {
            var request = indexedDB.open(CONFIG.FS_DB_NAME, CONFIG.VERSION);
            request.onerror = function() { reject(request.error); };
            request.onsuccess = function() {
                self.db = request.result;
                self.loadFSInfo().then(function() {
                    self.isInitialized = true;
                    resolve();
                });
            };
            request.onupgradeneeded = function(event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains(CONFIG.FS_STORE)) {
                    var store = db.createObjectStore(CONFIG.FS_STORE, { keyPath: 'path' });
                    store.createIndex('type', 'type', { unique: false });
                    store.createIndex('parent', 'parent', { unique: false });
                }
            };
        });
    };

    FileSystem.prototype.loadFSInfo = function() {
        var self = this;
        return new Promise(function(resolve) {
            var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
            var store = transaction.objectStore(CONFIG.FS_STORE);
            var request = store.getAll();
            request.onsuccess = function() {
                var items = request.result || [];
                self.currentSize = items.filter(function(i) { return i.type === 'file'; })
                    .reduce(function(sum, i) { return sum + (i.size || 0); }, 0);
                console.log('[MegaFS] Dosya sistemi yuklendi: ' + Utils.formatBytes(self.currentSize) + ' kullanimda');
                resolve();
            };
            request.onerror = function() { resolve(); };
        });
    };

    // ========== file.open() - Dosya Açma ==========
    FileSystem.prototype.fileOpen = function(path, mode) {
        var self = this;
        mode = mode || 'r';

        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);

            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var request = store.get(normalizedPath);

                request.onsuccess = function() {
                    var fileData = request.result;

                    if (!fileData && (mode === 'r' || mode === 'r+')) {
                        reject(new Error('Dosya bulunamadi: ' + path));
                        return;
                    }

                    var fileHandle = {
                        _path: normalizedPath,
                        _mode: mode,
                        _position: 0,
                        _data: fileData,
                        _modified: false,
                        _content: null,

                        get path() { return this._path; },
                        get name() { return this._data ? this._data.name : Utils.getBaseName(normalizedPath); },
                        get size() { return this._data ? this._data.size : 0; },
                        get type() { return 'file'; },
                        get created() { return this._data ? this._data.created : Date.now(); },
                        get modified() { return this._data ? this._data.modified : Date.now(); },
                        get mode() { return this._mode; },

                        read: function() {
                            var handle = this;
                            return new Promise(function(resolve, reject) {
                                if (handle._content !== null) {
                                    resolve(handle._content);
                                    return;
                                }
                                if (!handle._data) {
                                    handle._content = '';
                                    resolve(handle._content);
                                    return;
                                }
                                var blob = new Blob([handle._data.content]);
                                blob.text().then(function(text) {
                                    handle._content = text;
                                    resolve(handle._content);
                                }).catch(reject);
                            });
                        },

                        write: function(content) {
                            if (this._mode === 'r') {
                                return Promise.reject(new Error('Dosya sadece okuma modunda acik'));
                            }
                            this._content = String(content);
                            this._modified = true;
                            this._position = this._content.length;
                            return Promise.resolve(this._content.length);
                        },

                        append: function(content) {
                            if (this._mode !== 'a' && this._mode !== 'w' && this._mode !== 'r+') {
                                return Promise.reject(new Error('Dosya yazma modunda degil'));
                            }
                            var handle = this;
                            return this.read().then(function(existing) {
                                handle._content = existing + String(content);
                                handle._modified = true;
                                handle._position = handle._content.length;
                                return handle._content.length;
                            });
                        },

                        seek: function(position) {
                            this._position = Math.max(0, position);
                            return this._position;
                        },

                        tell: function() {
                            return this._position;
                        },

                        readLine: function() {
                            var handle = this;
                            return this.read().then(function(content) {
                                var lines = content.split("\n");
                                var lineIndex = 0;
                                var currentPos = 0;
                                for (var i = 0; i < lines.length; i++) {
                                    if (currentPos >= handle._position) {
                                        lineIndex = i;
                                        break;
                                    }
                                    currentPos += lines[i].length + 1;
                                }
                                if (lineIndex < lines.length) {
                                    handle._position = currentPos + lines[lineIndex].length + 1;
                                    return lines[lineIndex];
                                }
                                return null;
                            });
                        },

                        writeLine: function(line) {
                            return this.append(line + "\n");
                        },

                        save: function() {
                            var handle = this;
                            if (!handle._modified) {
                                return Promise.resolve(true);
                            }
                            return new Promise(function(resolve, reject) {
                                var blob = new Blob([handle._content]);
                                blob.arrayBuffer().then(function(arrayBuffer) {
                                    var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                                    var store = transaction.objectStore(CONFIG.FS_STORE);
                                    var now = Date.now();
                                    var parent = Utils.getDirName(handle._path);
                                    var name = Utils.getBaseName(handle._path);
                                    var fileData = {
                                        path: handle._path,
                                        name: name,
                                        parent: parent,
                                        type: 'file',
                                        content: arrayBuffer,
                                        size: arrayBuffer.byteLength,
                                        created: handle._data ? handle._data.created : now,
                                        modified: now
                                    };
                                    var request = store.put(fileData);
                                    request.onsuccess = function() {
                                        handle._data = fileData;
                                        handle._modified = false;
                                        if (!handle._data.created) {
                                            self.currentSize += arrayBuffer.byteLength;
                                        }
                                        console.log('[MegaFS] Dosya kaydedildi: ' + handle._path);
                                        resolve(true);
                                    };
                                    request.onerror = function() { reject(request.error); };
                                }).catch(reject);
                            });
                        },

                        close: function() {
                            var handle = this;
                            return new Promise(function(resolve) {
                                if (handle._modified) {
                                    handle.save().then(function() {
                                        self.openFiles.delete(handle._path);
                                        handle._content = null;
                                        handle._data = null;
                                        resolve(true);
                                    }).catch(function() {
                                        self.openFiles.delete(handle._path);
                                        resolve(false);
                                    });
                                } else {
                                    self.openFiles.delete(handle._path);
                                    handle._content = null;
                                    handle._data = null;
                                    resolve(true);
                                }
                            });
                        },

                        remove: function() {
                            var handle = this;
                            return self.delFile(handle._path).then(function() {
                                self.openFiles.delete(handle._path);
                                handle._content = null;
                                handle._data = null;
                                return true;
                            });
                        },

                        stat: function() {
                            return {
                                path: this._path,
                                name: this.name,
                                size: this.size,
                                created: this.created,
                                modified: this.modified,
                                mode: this._mode,
                                modifiedInMemory: this._modified,
                                position: this._position
                            };
                        }
                    };

                    self.openFiles.set(normalizedPath, fileHandle);
                    resolve(fileHandle);
                };

                request.onerror = function() { reject(request.error); };
            });
        });
    };

    // ========== folder.open() - Klasör Açma ==========
    FileSystem.prototype.folderOpen = function(path) {
        var self = this;

        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);

            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var folderRequest = normalizedPath ? store.get(normalizedPath) : { onsuccess: function() { this.result = null; } };

                folderRequest.onsuccess = function() {
                    var index = store.index('parent');
                    var childrenRequest = index.getAll(normalizedPath);

                    childrenRequest.onsuccess = function() {
                        var children = childrenRequest.result || [];

                        var fileMetas = children.map(function(item) {
                            return {
                                name: item.name,
                                path: item.path,
                                type: item.type,
                                size: item.size || 0,
                                created: item.created,
                                modified: item.modified,
                                isFile: item.type === 'file',
                                isFolder: item.type === 'folder',
                                extension: item.type === 'file' ? (item.name.split('.').pop() || '') : null
                            };
                        });

                        var folderHandle = {
                            _path: normalizedPath,
                            _children: children,
                            _metaCache: fileMetas,

                            get path() { return this._path; },
                            get name() { return normalizedPath ? Utils.getBaseName(normalizedPath) : 'root'; },
                            get type() { return 'folder'; },
                            get fileCount() { 
                                return this._children.filter(function(c) { return c.type === 'file'; }).length; 
                            },
                            get folderCount() { 
                                return this._children.filter(function(c) { return c.type === 'folder'; }).length; 
                            },
                            get totalCount() { return this._children.length; },
                            get totalSize() {
                                return this._children
                                    .filter(function(c) { return c.type === 'file'; })
                                    .reduce(function(sum, c) { return sum + (c.size || 0); }, 0);
                            },

                            getMeta: function() {
                                return this._metaCache;
                            },

                            getFiles: function() {
                                return this._metaCache.filter(function(m) { return m.isFile; });
                            },

                            getFolders: function() {
                                return this._metaCache.filter(function(m) { return m.isFolder; });
                            },

                            find: function(namePattern) {
                                var regex = new RegExp(namePattern, 'i');
                                return this._metaCache.filter(function(m) { 
                                    return regex.test(m.name); 
                                });
                            },

                            filterByExtension: function(ext) {
                                var dotExt = ext.startsWith('.') ? ext : '.' + ext;
                                return this._metaCache.filter(function(m) { 
                                    return m.isFile && m.name.toLowerCase().endsWith(dotExt.toLowerCase()); 
                                });
                            },

                            sortByDate: function(ascending) {
                                var sorted = this._metaCache.slice().sort(function(a, b) {
                                    return ascending ? a.modified - b.modified : b.modified - a.modified;
                                });
                                return sorted;
                            },

                            sortBySize: function(ascending) {
                                var sorted = this._metaCache.slice().sort(function(a, b) {
                                    return ascending ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
                                });
                                return sorted;
                            },

                            openFile: function(fileName, mode) {
                                var filePath = normalizedPath ? normalizedPath + '/' + fileName : fileName;
                                return self.fileOpen(filePath, mode);
                            },

                            openSubFolder: function(folderName) {
                                var subPath = normalizedPath ? normalizedPath + '/' + folderName : folderName;
                                return self.folderOpen(subPath);
                            },

                            createFile: function(fileName, initialContent) {
                                var filePath = normalizedPath ? normalizedPath + '/' + fileName : fileName;
                                return self.fileOpen(filePath, 'w').then(function(handle) {
                                    if (initialContent !== undefined) {
                                        return handle.write(initialContent).then(function() {
                                            return handle.save().then(function() {
                                                return handle;
                                            });
                                        });
                                    }
                                    return handle;
                                });
                            },

                            createFolder: function(folderName) {
                                var folderPath = normalizedPath ? normalizedPath + '/' + folderName : folderName;
                                return self.addFolder(folderPath);
                            },

                            remove: function(name) {
                                var itemPath = normalizedPath ? normalizedPath + '/' + name : name;
                                var item = this._metaCache.find(function(m) { return m.name === name; });
                                if (!item) {
                                    return Promise.reject(new Error('Bulunamadi: ' + name));
                                }
                                if (item.isFile) {
                                    return self.delFile(itemPath);
                                } else {
                                    return self.delFolder(itemPath);
                                }
                            },

                            refresh: function() {
                                var handle = this;
                                return self.folderOpen(normalizedPath).then(function(newHandle) {
                                    handle._children = newHandle._children;
                                    handle._metaCache = newHandle._metaCache;
                                    return handle;
                                });
                            },

                            stat: function() {
                                var files = this.getFiles();
                                var folders = this.getFolders();

                                return {
                                    path: this._path,
                                    name: this.name,
                                    totalItems: this.totalCount,
                                    files: this.fileCount,
                                    folders: this.folderCount,
                                    totalSize: this.totalSize,
                                    totalSizeFormatted: Utils.formatBytes(this.totalSize),
                                    avgFileSize: files.length > 0 ? Math.floor(this.totalSize / files.length) : 0,
                                    oldestFile: files.length > 0 ? files.reduce(function(min, f) { 
                                        return f.created < min.created ? f : min; 
                                    }).created : null,
                                    newestFile: files.length > 0 ? files.reduce(function(max, f) { 
                                        return f.modified > max.modified ? f : max; 
                                    }).modified : null
                                };
                            },

                            close: function() {
                                self.openFolders.delete(normalizedPath);
                                this._children = null;
                                this._metaCache = null;
                                return Promise.resolve(true);
                            }
                        };

                        self.openFolders.set(normalizedPath, folderHandle);
                        resolve(folderHandle);
                    };

                    childrenRequest.onerror = function() { reject(childrenRequest.error); };
                };

                if (folderRequest.onerror) {
                    folderRequest.onerror = function() { reject(folderRequest.error); };
                }
            });
        });
    };

    // ========== file.* ve folder.* metodlari ==========

    // file.add() - Dosya ekle
    FileSystem.prototype.fileAdd = function(path, content) {
        return this.addFile(path, content);
    };

    // file.del() - Dosya sil
    FileSystem.prototype.fileDel = function(path) {
        return this.delFile(path);
    };

    // file.move() - Dosya tasima
    FileSystem.prototype.fileMove = function(oldPath, newPath) {
        return this.moveFile(oldPath, newPath);
    };

    // file.read() - Dosya oku
    FileSystem.prototype.fileRead = function(path, asType) {
        return this.readFile(path, asType);
    };

    // file.exists() - Dosya var mi
    FileSystem.prototype.fileExists = function(path) {
        var self = this;
        return this.init().then(function() {
            return new Promise(function(resolve) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var request = store.get(Utils.normalizePath(path));
                request.onsuccess = function() { 
                    var result = request.result;
                    resolve(!!result && result.type === 'file'); 
                };
                request.onerror = function() { resolve(false); };
            });
        });
    };

    // folder.add() - Klasor ekle
    FileSystem.prototype.folderAdd = function(path) {
        return this.addFolder(path);
    };

    // folder.del() - Klasor sil
    FileSystem.prototype.folderDel = function(path) {
        return this.delFolder(path);
    };

    // folder.move() - Klasor tasima
    FileSystem.prototype.folderMove = function(oldPath, newPath) {
        return this.moveFolder(oldPath, newPath);
    };

    // folder.exists() - Klasor var mi
    FileSystem.prototype.folderExists = function(path) {
        var self = this;
        return this.init().then(function() {
            return new Promise(function(resolve) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var request = store.get(Utils.normalizePath(path));
                request.onsuccess = function() { 
                    var result = request.result;
                    resolve(!!result && result.type === 'folder'); 
                };
                request.onerror = function() { resolve(false); };
            });
        });
    };

    // Mevcut metodlar (addFile, delFile, vb.)
    FileSystem.prototype.addFile = function(path, content) {
        var self = this;
        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);
            var parent = Utils.getDirName(normalizedPath);
            var name = Utils.getBaseName(normalizedPath);
            var blob;
            var size;
            if (content instanceof Blob) {
                blob = content;
                size = content.size;
            } else if (content instanceof ArrayBuffer) {
                blob = new Blob([content]);
                size = content.byteLength;
            } else {
                blob = new Blob([String(content)]);
                size = blob.size;
            }
            if (self.currentSize + size > CONFIG.FS_MAX_SIZE) {
                throw new Error('Yetersiz alan!');
            }
            return blob.arrayBuffer().then(function(arrayBuffer) {
                return new Promise(function(resolve, reject) {
                    var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                    var store = transaction.objectStore(CONFIG.FS_STORE);
                    var fileData = {
                        path: normalizedPath, name: name, parent: parent, type: 'file',
                        content: arrayBuffer, size: size, created: Date.now(), modified: Date.now()
                    };
                    var request = store.put(fileData);
                    request.onsuccess = function() {
                        self.currentSize += size;
                        console.log('[MegaFS] Dosya eklendi: ' + normalizedPath);
                        resolve(true);
                    };
                    request.onerror = function() { reject(request.error); };
                });
            });
        });
    };

    FileSystem.prototype.delFile = function(path) {
        var self = this;
        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var getReq = store.get(normalizedPath);
                getReq.onsuccess = function() {
                    var file = getReq.result;
                    if (!file || file.type !== 'file') {
                        reject(new Error('Dosya bulunamadi: ' + path));
                        return;
                    }
                    var delReq = store.delete(normalizedPath);
                    delReq.onsuccess = function() {
                        self.currentSize -= file.size;
                        console.log('[MegaFS] Dosya silindi: ' + normalizedPath);
                        resolve(true);
                    };
                    delReq.onerror = function() { reject(delReq.error); };
                };
                getReq.onerror = function() { reject(getReq.error); };
            });
        });
    };

    FileSystem.prototype.addFolder = function(path) {
        var self = this;
        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);
            var parent = Utils.getDirName(normalizedPath);
            var name = Utils.getBaseName(normalizedPath);
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var folderData = {
                    path: normalizedPath, name: name, parent: parent, type: 'folder',
                    created: Date.now(), modified: Date.now()
                };
                var request = store.put(folderData);
                request.onsuccess = function() {
                    console.log('[MegaFS] Klasor olusturuldu: ' + normalizedPath);
                    resolve(true);
                };
                request.onerror = function() { reject(request.error); };
            });
        });
    };

    FileSystem.prototype.delFolder = function(path) {
        var self = this;
        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);
            return self.listAll(normalizedPath).then(function(items) {
                return new Promise(function(resolve, reject) {
                    var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                    var store = transaction.objectStore(CONFIG.FS_STORE);
                    var freedSize = 0;
                    items.forEach(function(item) {
                        if (item.type === 'file') freedSize += item.size;
                        store.delete(item.path);
                    });
                    store.delete(normalizedPath);
                    transaction.oncomplete = function() {
                        self.currentSize -= freedSize;
                        console.log('[MegaFS] Klasor silindi: ' + normalizedPath);
                        resolve(true);
                    };
                    transaction.onerror = function() { reject(transaction.error); };
                });
            });
        });
    };

    FileSystem.prototype.moveFile = function(oldPath, newPath) {
        var self = this;
        return this.init().then(function() {
            var normalizedOld = Utils.normalizePath(oldPath);
            var normalizedNew = Utils.normalizePath(newPath);
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var getReq = store.get(normalizedOld);
                getReq.onsuccess = function() {
                    var file = getReq.result;
                    if (!file || file.type !== 'file') {
                        reject(new Error('Dosya bulunamadi: ' + oldPath));
                        return;
                    }
                    file.path = normalizedNew;
                    file.name = Utils.getBaseName(normalizedNew);
                    file.parent = Utils.getDirName(normalizedNew);
                    file.modified = Date.now();
                    var putReq = store.put(file);
                    putReq.onsuccess = function() {
                        store.delete(normalizedOld);
                        console.log('[MegaFS] Dosya tasindi: ' + normalizedOld + ' -> ' + normalizedNew);
                        resolve(true);
                    };
                    putReq.onerror = function() { reject(putReq.error); };
                };
                getReq.onerror = function() { reject(getReq.error); };
            });
        });
    };

    FileSystem.prototype.moveFolder = function(oldPath, newPath) {
        var self = this;
        return this.init().then(function() {
            var normalizedOld = Utils.normalizePath(oldPath);
            var normalizedNew = Utils.normalizePath(newPath);
            return self.listAll(normalizedOld).then(function(items) {
                return new Promise(function(resolve, reject) {
                    var transaction = self.db.transaction([CONFIG.FS_STORE], 'readwrite');
                    var store = transaction.objectStore(CONFIG.FS_STORE);
                    items.forEach(function(item) {
                        var relativePath = item.path.substring(normalizedOld.length);
                        var itemNewPath = normalizedNew + relativePath;
                        item.path = itemNewPath;
                        item.parent = Utils.getDirName(itemNewPath);
                        if (item.name) item.name = Utils.getBaseName(itemNewPath);
                        item.modified = Date.now();
                        store.put(item);
                    });
                    transaction.oncomplete = function() {
                        console.log('[MegaFS] Klasor tasindi: ' + normalizedOld + ' -> ' + normalizedNew);
                        resolve(true);
                    };
                    transaction.onerror = function() { reject(transaction.error); };
                });
            });
        });
    };

    FileSystem.prototype.readFile = function(path, asType) {
        var self = this;
        asType = asType || 'text';
        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var request = store.get(normalizedPath);
                request.onsuccess = function() {
                    var file = request.result;
                    if (!file || file.type !== 'file') {
                        reject(new Error('Dosya bulunamadi: ' + path));
                        return;
                    }
                    var blob = new Blob([file.content]);
                    if (asType === 'text') {
                        blob.text().then(resolve).catch(reject);
                    } else if (asType === 'arraybuffer') {
                        blob.arrayBuffer().then(resolve).catch(reject);
                    } else if (asType === 'blob') {
                        resolve(blob);
                    } else if (asType === 'url') {
                        resolve(URL.createObjectURL(blob));
                    } else {
                        resolve(file.content);
                    }
                };
                request.onerror = function() { reject(request.error); };
            });
        });
    };

    FileSystem.prototype.listFolder = function(path) {
        var self = this;
        path = path || '';
        return this.init().then(function() {
            var normalizedPath = Utils.normalizePath(path);
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var index = store.index('parent');
                var request = index.getAll(normalizedPath);
                request.onsuccess = function() { resolve(request.result || []); };
                request.onerror = function() { reject(request.error); };
            });
        });
    };

    FileSystem.prototype.listAll = function(path) {
        var self = this;
        path = path || '';
        var items = [];
        var queue = [path];
        function processQueue() {
            if (queue.length === 0) return Promise.resolve(items);
            var current = queue.shift();
            return self.listFolder(current).then(function(children) {
                children.forEach(function(child) {
                    items.push(child);
                    if (child.type === 'folder') queue.push(child.path);
                });
                return processQueue();
            });
        }
        return processQueue();
    };

    FileSystem.prototype.exists = function(path) {
        var self = this;
        return this.init().then(function() {
            return new Promise(function(resolve) {
                var transaction = self.db.transaction([CONFIG.FS_STORE], 'readonly');
                var store = transaction.objectStore(CONFIG.FS_STORE);
                var request = store.get(Utils.normalizePath(path));
                request.onsuccess = function() { resolve(!!request.result); };
                request.onerror = function() { resolve(false); };
            });
        });
    };

    FileSystem.prototype.getStats = function() {
        return {
            used: this.currentSize,
            max: CONFIG.FS_MAX_SIZE,
            percent: ((this.currentSize / CONFIG.FS_MAX_SIZE) * 100).toFixed(4)
        };
    };

    // ==================== DEĞİŞKEN YÖNETİMİ ====================
    function VariableManager() {
        this.variables = new Map();
        this.db = null;
        this.isInitialized = false;
    }

    VariableManager.prototype.init = function() {
        if (this.isInitialized) return Promise.resolve();
        var self = this;
        return new Promise(function(resolve, reject) {
            var request = indexedDB.open('MegaVarsDB', 1);
            request.onerror = function() { reject(request.error); };
            request.onsuccess = function() {
                self.db = request.result;
                self.loadVariables().then(function() {
                    self.isInitialized = true;
                    resolve();
                });
            };
            request.onupgradeneeded = function(event) {
                var db = event.target.result;
                if (!db.objectStoreNames.contains('variables')) {
                    db.createObjectStore('variables', { keyPath: 'name' });
                }
            };
        });
    };

    VariableManager.prototype.loadVariables = function() {
        var self = this;
        return new Promise(function(resolve) {
            var transaction = self.db.transaction(['variables'], 'readonly');
            var store = transaction.objectStore('variables');
            var request = store.getAll();
            request.onsuccess = function() {
                var items = request.result || [];
                items.forEach(function(item) { self.variables.set(item.name, item); });
                resolve();
            };
            request.onerror = function() { resolve(); };
        });
    };

    VariableManager.prototype.saveVariable = function(name, data) {
        var self = this;
        return this.init().then(function() {
            return new Promise(function(resolve, reject) {
                var transaction = self.db.transaction(['variables'], 'readwrite');
                var store = transaction.objectStore('variables');
                var request = store.put({ name: name, type: data.type, value: data.value, updated: Date.now() });
                request.onsuccess = function() { resolve(); };
                request.onerror = function() { reject(request.error); };
            });
        });
    };

    VariableManager.prototype.int = function(name, value) {
        var bigValue = BigInt(value);
        var data = { type: 'bigint', value: bigValue.toString(), original: value };
        this.variables.set(name, data);
        this.saveVariable(name, data);
        return {
            value: bigValue,
            toString: function() { return bigValue.toString(); },
            toNumber: function() { return Number(bigValue); },
            add: function(n) { return bigValue + BigInt(n); },
            sub: function(n) { return bigValue - BigInt(n); },
            mul: function(n) { return bigValue * BigInt(n); },
            div: function(n) { return bigValue / BigInt(n); }
        };
    };

    VariableManager.prototype.getInt = function(name) {
        var data = this.variables.get(name);
        if (!data || data.type !== 'bigint') return null;
        return BigInt(data.value);
    };

    var stdvar = {
        variables: new Map(),
        db: null,
        init: function() {
            if (this.db) return Promise.resolve();
            var self = this;
            return new Promise(function(resolve, reject) {
                var request = indexedDB.open('StdVarDB', 1);
                request.onerror = function() { reject(request.error); };
                request.onsuccess = function() {
                    self.db = request.result;
                    resolve();
                };
                request.onupgradeneeded = function(e) {
                    var db = e.target.result;
                    if (!db.objectStoreNames.contains('stdvars')) {
                        db.createObjectStore('stdvars', { keyPath: 'name' });
                    }
                };
            });
        },
        save: function(name, data) {
            var self = this;
            return this.init().then(function() {
                return new Promise(function(resolve, reject) {
                    var transaction = self.db.transaction(['stdvars'], 'readwrite');
                    var store = transaction.objectStore('stdvars');
                    var request = store.put({ name: name, type: data.type, value: data.value, updated: Date.now() });
                    request.onsuccess = function() { resolve(); };
                    request.onerror = function() { reject(request.error); };
                });
            });
        },
        float: function(name, value) {
            var float32 = new Float32Array(1);
            float32[0] = value;
            var data = { type: 'float32', value: float32[0], raw: Array.from(float32) };
            this.variables.set(name, data);
            this.save(name, data);
            return {
                value: float32[0],
                raw: float32,
                precision: 'single',
                bytes: 4,
                toString: function() { return float32[0].toString(); },
                toFixed: function(n) { return float32[0].toFixed(n); },
                add: function(n) {
                    float32[0] += n;
                    return stdvar.float(name, float32[0]);
                }
            };
        },
        decimal: function(name, value) {
            var PRECISION = 18;
            var MULTIPLIER = BigInt(Math.pow(10, PRECISION));
            var bigValue;
            if (typeof value === 'string' && value.indexOf('.') !== -1) {
                var parts = value.split('.');
                var intPart = parts[0];
                var decPart = (parts[1] + '000000000000000000').substring(0, PRECISION);
                bigValue = BigInt(intPart) * MULTIPLIER + BigInt(decPart);
                if (value.charAt(0) === '-') bigValue = -bigValue;
            } else if (typeof value === 'number') {
                bigValue = BigInt(Math.round(value * Number(MULTIPLIER)));
            } else {
                bigValue = BigInt(value) * MULTIPLIER;
            }
            var data = { type: 'decimal', value: bigValue.toString(), precision: PRECISION };
            this.variables.set(name, data);
            this.save(name, data);
            return {
                rawValue: bigValue,
                precision: PRECISION,
                toString: function() {
                    var str = bigValue.toString().padStart(PRECISION + 1, '0');
                    var intPart = str.slice(0, -PRECISION) || '0';
                    var decPart = str.slice(-PRECISION).replace(/0+$/, '');
                    return decPart ? intPart + '.' + decPart : intPart;
                },
                toNumber: function() { return Number(bigValue) / Number(MULTIPLIER); },
                add: function(n) {
                    var other;
                    if (typeof n === 'string' && n.indexOf('.') !== -1) {
                        var p = n.split('.');
                        var padded = (p[1] + '000000000000000000').substring(0, PRECISION);
                        other = BigInt(p[0]) * MULTIPLIER + BigInt(padded);
                    } else {
                        other = BigInt(Math.round(Number(n) * Number(MULTIPLIER)));
                    }
                    return stdvar.decimal(name, bigValue + other);
                },
                sub: function(n) {
                    var other = BigInt(Math.round(Number(n) * Number(MULTIPLIER)));
                    return stdvar.decimal(name, bigValue - other);
                },
                mul: function(n) {
                    var other = BigInt(Math.round(Number(n) * Number(MULTIPLIER)));
                    return stdvar.decimal(name, (bigValue * other) / MULTIPLIER);
                },
                div: function(n) {
                    var other = BigInt(Math.round(Number(n) * Number(MULTIPLIER)));
                    return stdvar.decimal(name, (bigValue * MULTIPLIER) / other);
                }
            };
        },
        get: function(name) {
            return this.variables.get(name) || null;
        }
    };

    var megaCache = new CacheManager();
    var constfs = new FileSystem();
    var save = new VariableManager();

    // ========== GLOBAL API - dogrudan file ve folder ==========

    // file.* - Dogrudan global erisim
    global.file = {
        open: function(path, mode) { return constfs.fileOpen(path, mode); },
        add: function(path, content) { return constfs.fileAdd(path, content); },
        del: function(path) { return constfs.fileDel(path); },
        move: function(oldPath, newPath) { return constfs.fileMove(oldPath, newPath); },
        read: function(path, type) { return constfs.fileRead(path, type); },
        exists: function(path) { return constfs.fileExists(path); }
    };

    // folder.* - Dogrudan global erisim
    global.folder = {
        open: function(path) { return constfs.folderOpen(path); },
        add: function(path) { return constfs.folderAdd(path); },
        del: function(path) { return constfs.folderDel(path); },
        move: function(oldPath, newPath) { return constfs.folderMove(oldPath, newPath); },
        exists: function(path) { return constfs.folderExists(path); },
        list: function(path) { return constfs.listFolder(path); }
    };

    // MegaCacheFS namespace (detayli API)
    global.MegaCacheFS = {
        cache: {
            init: function() { return megaCache.init(); },
            scan: function(url) { return megaCache.cacheIndexAndDependencies(url); },
            load: function(url) { return megaCache.loadFromCacheFirst(url); },
            clear: function() { return megaCache.clearCache(); },
            stats: function() { return megaCache.getStats(); },
            checkUpdates: function() {
                var promises = [];
                megaCache.cacheMap.forEach(function(data, url) {
                    promises.push(megaCache.checkForUpdate(url, data.hash));
                });
                return Promise.all(promises);
            }
        },

        // file.* API
        file: global.file,

        // folder.* API
        folder: global.folder,

        // Eski fs.* API (geriye uyumluluk)
        fs: {
            addFile: function(path, content) { return constfs.addFile(path, content); },
            delFile: function(path) { return constfs.delFile(path); },
            addFolder: function(path) { return constfs.addFolder(path); },
            delFolder: function(path) { return constfs.delFolder(path); },
            moveFile: function(oldPath, newPath) { return constfs.moveFile(oldPath, newPath); },
            moveFolder: function(oldPath, newPath) { return constfs.moveFolder(oldPath, newPath); },
            readFile: function(path, type) { return constfs.readFile(path, type); },
            list: function(path) { return constfs.listFolder(path); },
            exists: function(path) { return constfs.exists(path); },
            stats: function() { return constfs.getStats(); },
            open: function(path, mode) { return constfs.fileOpen(path, mode); },
            openFolder: function(path) { return constfs.folderOpen(path); }
        },

        save: {
            int: function(name, value) { return save.int(name, value); },
            getInt: function(name) { return save.getInt(name); }
        },

        stdvar: stdvar,
        utils: Utils,
        config: CONFIG
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            console.log('[MegaCacheFS] Hazir! file.* ve folder.* aktif!');
        });
    } else {
        console.log('[MegaCacheFS] Hazir! file.* ve folder.* aktif!');
    }

})(typeof window !== 'undefined' ? window : global);

console.log("hello")