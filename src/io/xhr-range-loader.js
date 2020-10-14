/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

 /**
  * RangeLoader类-通用的范围加载器
  */
import Log from '../utils/logger.js';
import SpeedSampler from './speed-sampler.js';
import {BaseLoader, LoaderStatus, LoaderErrors} from './loader.js';
import {RuntimeException} from '../utils/exception.js';

// Universal IO Loader, implemented by adding Range header in xhr's request header
class RangeLoader extends BaseLoader {

    static isSupported() {
        try {
            let xhr = new XMLHttpRequest();
            xhr.open('GET', 'https://example.com', true);
            xhr.responseType = 'arraybuffer';
            return (xhr.responseType === 'arraybuffer');
        } catch (e) {
            Log.w('RangeLoader', e.message);
            return false;
        }
    }

    constructor(seekHandler, config) {
        super('xhr-range-loader');
        this.TAG = 'RangeLoader';

        this._seekHandler = seekHandler;
        this._config = config;
        this._needStash = false;

        this._chunkSizeKBList = [
            128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 5120, 6144, 7168, 8192
        ];
        this._currentChunkSizeKB = 384;
        this._currentSpeedNormalized = 0;//当前标准化的加载速率
        this._zeroSpeedChunkCount = 0;//待加载数据块数量

        this._xhr = null;
        this._speedSampler = new SpeedSampler();//速率计算器

        this._requestAbort = false;
        this._waitForTotalLength = false;//是否待加载
        this._totalLengthReceived = false;//是否全部接收

        this._currentRequestURL = null;
        this._currentRedirectedURL = null;
        this._currentRequestRange = null;
        this._totalLength = null;  // size of the entire file 总长度
        this._contentLength = null;  // Content-Length of entire request range 内容长度
        this._receivedLength = 0;  // total received bytes 接收长度
        this._lastTimeLoaded = 0;  // received bytes of current request sub-range 当前请求子范围的接收字节长度
    }

    destroy() {
        if (this.isWorking()) {
            this.abort();
        }
        if (this._xhr) {
            this._xhr.onreadystatechange = null;
            this._xhr.onprogress = null;
            this._xhr.onload = null;
            this._xhr.onerror = null;
            this._xhr = null;
        }
        super.destroy();
    }

    get currentSpeed() {
        return this._speedSampler.lastSecondKBps;
    }

    open(dataSource, range) {
        this._dataSource = dataSource;
        this._range = range;
        this._status = LoaderStatus.kConnecting;

        let useRefTotalLength = false;
        if (this._dataSource.filesize != undefined && this._dataSource.filesize !== 0) {
            useRefTotalLength = true;
            this._totalLength = this._dataSource.filesize;
        }
        // 如果实例的已接收总长度为 0
        if (!this._totalLengthReceived && !useRefTotalLength) {
            // We need total filesize
            this._waitForTotalLength = true;//设置是否待加载为 true
            this._internalOpen(this._dataSource, {from: 0, to: -1});
        } else {
            // We have filesize, start loading
            this._openSubRange();
        }
    }

    /**
     * 加载指定范围数据
     */
    _openSubRange() {
        // 创建 chunkSize 为实例当前数据块大小 * 1024
        let chunkSize = this._currentChunkSizeKB * 1024;

        let from = this._range.from + this._receivedLength;
        let to = from + chunkSize;

        if (this._contentLength != null) {
            if (to - this._range.from >= this._contentLength) {
                to = this._range.from + this._contentLength - 1;
            }
        }

        this._currentRequestRange = {from, to};
        this._internalOpen(this._dataSource, this._currentRequestRange);
    }

    _internalOpen(dataSource, range) {
        this._lastTimeLoaded = 0;

        let sourceURL = dataSource.url;
        if (this._config.reuseRedirectedURL) {
            if (this._currentRedirectedURL != undefined) {
                sourceURL = this._currentRedirectedURL;
            } else if (dataSource.redirectedURL != undefined) {
                sourceURL = dataSource.redirectedURL;
            }
        }

        let seekConfig = this._seekHandler.getConfig(sourceURL, range);
        this._currentRequestURL = seekConfig.url;

        let xhr = this._xhr = new XMLHttpRequest();
        xhr.open('GET', seekConfig.url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onreadystatechange = this._onReadyStateChange.bind(this);
        xhr.onprogress = this._onProgress.bind(this);
        xhr.onload = this._onLoad.bind(this);
        xhr.onerror = this._onXhrError.bind(this);

        if (dataSource.withCredentials) {
            xhr.withCredentials = true;
        }

        if (typeof seekConfig.headers === 'object') {
            let headers = seekConfig.headers;

            for (let key in headers) {
                if (headers.hasOwnProperty(key)) {
                    xhr.setRequestHeader(key, headers[key]);
                }
            }
        }

        // add additional headers
        if (typeof this._config.headers === 'object') {
            let headers = this._config.headers;

            for (let key in headers) {
                if (headers.hasOwnProperty(key)) {
                    xhr.setRequestHeader(key, headers[key]);
                }
            }
        }

        xhr.send();
    }

    abort() {
        this._requestAbort = true;
        this._internalAbort();
        this._status = LoaderStatus.kComplete;
    }

    _internalAbort() {
        if (this._xhr) {
            this._xhr.onreadystatechange = null;
            this._xhr.onprogress = null;
            this._xhr.onload = null;
            this._xhr.onerror = null;
            this._xhr.abort();
            this._xhr = null;
        }
    }

    _onReadyStateChange(e) {
        let xhr = e.target;

        if (xhr.readyState === 2) {  // HEADERS_RECEIVED
            if (xhr.responseURL != undefined) {  // if the browser support this property
                let redirectedURL = this._seekHandler.removeURLParameters(xhr.responseURL);
                if (xhr.responseURL !== this._currentRequestURL && redirectedURL !== this._currentRedirectedURL) {
                    this._currentRedirectedURL = redirectedURL;
                    if (this._onURLRedirect) {
                        this._onURLRedirect(redirectedURL);
                    }
                }
            }

            if ((xhr.status >= 200 && xhr.status <= 299)) {
                //  如果实例的是否待加载为 true，结束
                if (this._waitForTotalLength) {
                    return;
                }
                this._status = LoaderStatus.kBuffering;
            } else {
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    this._onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code: xhr.status, msg: xhr.statusText});
                } else {
                    throw new RuntimeException('RangeLoader: Http code invalid, ' + xhr.status + ' ' + xhr.statusText);
                }
            }
        }
    }

    _onProgress(e) {
        if (this._status === LoaderStatus.kError) {
            // Ignore error response
            return;
        }
        // 首次加载
        if (this._contentLength === null) {
            let openNextRange = false;
            // 如果实例 是否待加载为 true
            if (this._waitForTotalLength) {
                this._waitForTotalLength = false;
                this._totalLengthReceived = true;//设置实例是否全部接收为 true
                openNextRange = true;

                let total = e.total;
                this._internalAbort();
                if (total != null & total !== 0) {
                    this._totalLength = total;
                }
            }

            // calculate currrent request range's contentLength
            if (this._range.to === -1) {
                this._contentLength = this._totalLength - this._range.from;
            } else {  // to !== -1
                this._contentLength = this._range.to - this._range.from + 1;
            }

            if (openNextRange) {
                this._openSubRange();
                return;
            }
            if (this._onContentLengthKnown) {
                this._onContentLengthKnown(this._contentLength);
            }
        }

        //  创建 delta 为 e.loaded 实例当前接收请求子范围
        let delta = e.loaded - this._lastTimeLoaded;
        // 设置实例当前接收请求子范围的长度为 e.loaded
        this._lastTimeLoaded = e.loaded;
        // 将实例速率计算器增加 delta 这么多字节
        this._speedSampler.addBytes(delta);
    }

    /**
     * 和 IOCtr 的标准化速率方法实现几乎一样
     * @param {*} input 
     */
    _normalizeSpeed(input) {
        let list = this._chunkSizeKBList;
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        if (input < list[0]) {
            return list[0];
        }

        while (lbound <= ubound) {
            mid = lbound + Math.floor((ubound - lbound) / 2);
            if (mid === last || (input >= list[mid] && input < list[mid + 1])) {
                return list[mid];
            } else if (list[mid] < input) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }
    }

    _onLoad(e) {
        if (this._status === LoaderStatus.kError) {
            // Ignore error response
            return;
        }

        if (this._waitForTotalLength) {
            this._waitForTotalLength = false;
            return;
        }

        this._lastTimeLoaded = 0;
        //  获取实例速率计算器中的最近一次的速率
        let KBps = this._speedSampler.lastSecondKBps;
        if (KBps === 0) {
            this._zeroSpeedChunkCount++;
            if (this._zeroSpeedChunkCount >= 3) {
                // Try get currentKBps after 3 chunks
                KBps = this._speedSampler.currentKBps;
            }
        }

        if (KBps !== 0) {
            // 如果实例当前标准速率不等于标准化后的 KBps，校正实例标准速率为标准化后的 KBps，实例当前数据块大小为标准化后的 KBps
            let normalized = this._normalizeSpeed(KBps);
            if (this._currentSpeedNormalized !== normalized) {
                this._currentSpeedNormalized = normalized;
                this._currentChunkSizeKB = normalized;//？？？？当前块大小等于当前变准化速率？？？？？
            }
        }
        // 从 e .target .response 获取 chunk
        let chunk = e.target.response;
        
        let byteStart = this._range.from + this._receivedLength;
        // 将实例的接收长度加上 chunk 的字节长度
        this._receivedLength += chunk.byteLength;

        let reportComplete = false;

        // 如果实例的内容长度不为空且实例接收长度 < 实例的内容长度，调用 _openSubRange 继续加载剩下的数据
        if (this._contentLength != null && this._receivedLength < this._contentLength) {
            // continue load next chunk
            this._openSubRange();
        } else {
            reportComplete = true;
        }

        // dispatch received chunk
        if (this._onDataArrival) {
            this._onDataArrival(chunk, byteStart, this._receivedLength);
        }

        if (reportComplete) {
            this._status = LoaderStatus.kComplete;
            if (this._onComplete) {
                this._onComplete(this._range.from, this._range.from + this._receivedLength - 1);
            }
        }
    }

    _onXhrError(e) {
        this._status = LoaderStatus.kError;
        let type = 0;
        let info = null;

        if (this._contentLength && this._receivedLength > 0
                                && this._receivedLength < this._contentLength) {
            type = LoaderErrors.EARLY_EOF;
            info = {code: -1, msg: 'RangeLoader meet Early-Eof'};
        } else {
            type = LoaderErrors.EXCEPTION;
            info = {code: -1, msg: e.constructor.name + ' ' + e.type};
        }

        if (this._onError) {
            this._onError(type, info);
        } else {
            throw new RuntimeException(info.msg);
        }
    }

}

export default RangeLoader;