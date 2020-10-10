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

import Log from '../utils/logger.js';
import SpeedSampler from './speed-sampler.js';
import {LoaderStatus, LoaderErrors} from './loader.js';
import FetchStreamLoader from './fetch-stream-loader.js';
import MozChunkedLoader from './xhr-moz-chunked-loader.js';
import MSStreamLoader from './xhr-msstream-loader.js';
import RangeLoader from './xhr-range-loader.js';
import WebSocketLoader from './websocket-loader.js';
import RangeSeekHandler from './range-seek-handler.js';
import ParamSeekHandler from './param-seek-handler.js';
import {RuntimeException, IllegalStateException, InvalidArgumentException} from '../utils/exception.js';

/**
 * DataSource: {
 *     url: string,
 *     filesize: number,
 *     cors: boolean,
 *     withCredentials: boolean
 * }
 * 
 */

// Manage IO Loaders
class IOController {

    constructor(dataSource, config, extraData) {
        // 属性分为基本信息、暂存区信息、加载器信息、数据信息、速率信息、IO 状态信息、事件处理器
        // 1.1基本信息 TAG 用来描述当前构造器名称、_config 接收用户自定义配置、_extraData 是提取的数据（这块1.0 版本只在转码控制器里用了）
        this.TAG = 'IOController';

        this._config = config;
        this._extraData = extraData;

        // 1.2暂存区，_stashInitialSize 是初始大小，如果非实时流 384K，否则512K，_stashUsed 是已使用空间，_stashSize 是真实大小，还有 _bufferSize 3M 缓存区大小，对应的还有 _stashBuffer 暂存缓存和 _stashByteStart 暂存起点，可以通过 config.enableStashBuffer 控制 _enableStash 是否开启暂存
        this._stashInitialSize = 1024 * 384;  // default initial size: 384KB
        if (config.stashInitialSize != undefined && config.stashInitialSize > 0) {
            // apply from config
            this._stashInitialSize = config.stashInitialSize;
        }

        this._stashUsed = 0;
        this._stashSize = this._stashInitialSize;
        this._bufferSize = 1024 * 1024 * 3;  // initial size: 3MB
        this._stashBuffer = new ArrayBuffer(this._bufferSize);
        this._stashByteStart = 0;
        this._enableStash = true;
        if (config.enableStashBuffer === false) {
            this._enableStash = false;
        }

        // 1.3 加载器信息只有 _loader 加载器实例、_loaderClass 加载器类型、_seekHandler 搜索处理器
        /**
         * 1.3.1 _loader.status 关联实例只读属性 status
         * 1.3.2 _loader.currentSpeed 关联实例读写属性 currentSpeed
         * 1.3.3 _loader.type 关联实例读写属性 loaderType
         */
        this._loader = null;
        this._loaderClass = null;
        this._seekHandler = null;

        /**
         * 1.4 数据信息有 
         * _dataSource 原始数据源、
         * _isWebSocketURL 是否是 ws 协议、
         * _refTotalLength 原数据大小、
         * _totalLength 数据总长度、
         * _fullRequestFlag 请求全部标志位、
         * _currentRange 当前的数据范围
         * 1.4.1 _dataSource.currentUrl 关联实例只读属性 currentUrl
         */
        this._dataSource = dataSource;
        this._isWebSocketURL = /wss?:\/\/(.+?)/.test(dataSource.url);
        this._refTotalLength = dataSource.filesize ? dataSource.filesize : null;
        this._totalLength = this._refTotalLength;
        this._fullRequestFlag = false;
        this._currentRange = null;
        this._redirectedURL = null;

        /**
         * 速率信息有 
         * _speed 速率、
         * _speedNormalized 标准速率、
         * _speedSampler 速率计算器、
         * _speedNormalizeList 常规速率表
         */
        this._speedNormalized = 0;
        this._speedSampler = new SpeedSampler();
        this._speedNormalizeList = [64, 128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];

        /**
         * 1.6 IO 状态信息有 
         * _isEarlyEofReconnecting 是否过早结束、
         * _paused 是否暂停、
         * _resumeFrom 恢复点
         */
        this._isEarlyEofReconnecting = false;

        this._paused = false;
        this._resumeFrom = 0;

        /**
         * 1.7 事件处理器有 
         * _onDataArrival 数据抵达、
         * _onSeeked 搜索、
         * _onError 出错、
         * _onComplete 完成、
         * _onRecoveredEarlyEof 过早结束
         * 1.7.1 这五个属性都有相应的实例读写属性
         */
        this._onDataArrival = null;
        this._onSeeked = null;
        this._onError = null;
        this._onComplete = null;
        this._onRedirect = null;
        this._onRecoveredEarlyEof = null;

        // 构造函数里执行了选择搜索处理函数、选择加载器、创建加载器的操作
        this._selectSeekHandler();
        this._selectLoader();
        this._createLoader();
    }

    /**
     * 外部方法分为获取状态的、控制状态的、操作数据的 
     * 3.1 获取状态的有 isWorking 和 isPaused 
     * 3.2 控制状态的有 open、pause、resume、abort、destroy
     */
    // 销毁当前实例
    destroy() {
        // 如果当前加载器正在加载，就先终止加载
        if (this._loader.isWorking()) {
            this._loader.abort();
        }
        // 销毁当前实例的加载器，清空构造函数初始化的哪些变量
        this._loader.destroy();
        this._loader = null;
        this._loaderClass = null;
        this._dataSource = null;
        this._stashBuffer = null;
        this._stashUsed = this._stashSize = this._bufferSize = this._stashByteStart = 0;
        this._currentRange = null;
        this._speedSampler = null;

        this._isEarlyEofReconnecting = false;

        this._onDataArrival = null;
        this._onSeeked = null;
        this._onError = null;
        this._onComplete = null;
        this._onRedirect = null;
        this._onRecoveredEarlyEof = null;

        this._extraData = null;
    }

    // 当前实例存在加载器、当前实例加载器正常运行、当前实例没有暂停
    isWorking() {
        return this._loader && this._loader.isWorking() && !this._paused;
    }

    // 返回 this._paused 的值
    isPaused() {
        return this._paused;
    }

    get status() {
        return this._loader.status;
    }

    get extraData() {
        return this._extraData;
    }

    set extraData(data) {
        this._extraData = data;
    }

    // prototype: function onDataArrival(chunks: ArrayBuffer, byteStart: number): number
    get onDataArrival() {
        return this._onDataArrival;
    }

    set onDataArrival(callback) {
        this._onDataArrival = callback;
    }

    get onSeeked() {
        return this._onSeeked;
    }

    set onSeeked(callback) {
        this._onSeeked = callback;
    }

    // prototype: function onError(type: number, info: {code: number, msg: string}): void
    get onError() {
        return this._onError;
    }

    set onError(callback) {
        this._onError = callback;
    }

    get onComplete() {
        return this._onComplete;
    }

    set onComplete(callback) {
        this._onComplete = callback;
    }

    get onRedirect() {
        return this._onRedirect;
    }

    set onRedirect(callback) {
        this._onRedirect = callback;
    }

    get onRecoveredEarlyEof() {
        return this._onRecoveredEarlyEof;
    }

    set onRecoveredEarlyEof(callback) {
        this._onRecoveredEarlyEof = callback;
    }

    get currentURL() {
        return this._dataSource.url;
    }

    get hasRedirect() {
        return (this._redirectedURL != null || this._dataSource.redirectedURL != undefined);
    }

    get currentRedirectedURL() {
        return this._redirectedURL || this._dataSource.redirectedURL;
    }

    // in KB/s
    get currentSpeed() {
        if (this._loaderClass === RangeLoader) {
            // SpeedSampler is inaccuracy if loader is RangeLoader
            return this._loader.currentSpeed;
        }
        return this._speedSampler.lastSecondKBps;
    }

    get loaderType() {
        return this._loader.type;
    }
    // 选择搜索处理函数
    _selectSeekHandler() {
        let config = this._config;
        // 根据实例的配置的搜索类型，从三种：range、param、custom 处理函数选择一个
        // 如果搜索类型是 range，实例化一个 RangeSeekHandler 赋给实例的搜索处理函数，传入实例配置的范围是否从零开始属性
        if (config.seekType === 'range') {
            this._seekHandler = new RangeSeekHandler(this._config.rangeLoadZeroStart);
        } else if (config.seekType === 'param') {
            // 初始化参数起点，为实例配置的参数起点值或 bstart
            let paramStart = config.seekParamStart || 'bstart';
            // 初始化参数终点，为实例配置的参数终点值或 bend
            let paramEnd = config.seekParamEnd || 'bend';
            // 实例化一个 ParamSeekHandler 赋给实例的搜索处理函数，传入参数起点和终点
            this._seekHandler = new ParamSeekHandler(paramStart, paramEnd);
        } else if (config.seekType === 'custom') {
            // 如果实例配置的自定义搜索处理函数无效，报错
            if (typeof config.customSeekHandler !== 'function') {
                throw new InvalidArgumentException('Custom seekType specified in config but invalid customSeekHandler!');
            }
            // 实例化一个自定义搜索处理函数实例 赋给实例的搜索处理函数
            this._seekHandler = new config.customSeekHandler();
        } else {
            // 否则报不合法的参数错
            throw new InvalidArgumentException(`Invalid seekType in config: ${config.seekType}`);
        }
    }
    // 选择加载器
    _selectLoader() {
        if (this._config.customLoader != null) {
            // 如果配置的有加载器就使用配置的加载器
            this._loaderClass = this._config.customLoader;
        } else if (this._isWebSocketURL) {
            // 如果实例有 ws 协议，设置实例的加载器类型为 WebSocketLoader
            this._loaderClass = WebSocketLoader;
        } else if (FetchStreamLoader.isSupported()) {
            // 如果支持 fetch 流，设置实例的加载器类型为 FetchStreamLoader
            this._loaderClass = FetchStreamLoader;
        } else if (MozChunkedLoader.isSupported()) {
            // 如果支持火狐，设置实例的加载器类型为 MozChunkedLoader
            this._loaderClass = MozChunkedLoader;
        } else if (RangeLoader.isSupported()) {
            // 如果支持通用加载器，设置实例的加载器类型为 RangeLoader
            this._loaderClass = RangeLoader;
        } else {
            // 否则，报运行时的浏览器不支持二进制响应数据错
            throw new RuntimeException('Your browser doesn\'t support xhr with arraybuffer responseType!');
        }
    }
    // 创建加载器
    _createLoader() {
        //  根据加载器类型，将搜索处理器作为参数，实例化一个加载器，赋给实例的加载器
        this._loader = new this._loaderClass(this._seekHandler, this._config);
        if (this._loader.needStashBuffer === false) {
            // 如果实例的加载器的需要暂存缓存为 false，就将实例的是否开启暂存设置为 false
            this._enableStash = false;
        }
        // 将实例的加载器的事件处理函数和实例的事件处理函数关联起来
        this._loader.onContentLengthKnown = this._onContentLengthKnown.bind(this);
        this._loader.onURLRedirect = this._onURLRedirect.bind(this);
        this._loader.onDataArrival = this._onLoaderChunkArrival.bind(this);
        this._loader.onComplete = this._onLoaderComplete.bind(this);
        this._loader.onError = this._onLoaderError.bind(this);
    }

    // 用来从一个起点开始加载数据
    open(optionalFrom) {
        // 设置当前实例的当前范围为 0 到 -1
        this._currentRange = {from: 0, to: -1};
        // 将实例的当前范围起点设置为传入的起点，如果未传入参数，设置请求全部标志位为真
        if (optionalFrom) {
            this._currentRange.from = optionalFrom;
        }
        // 重置当前实例的速率计算器
        this._speedSampler.reset();
        if (!optionalFrom) {
            this._fullRequestFlag = true;
        }
        // 打开当前实例的加载器
        this._loader.open(this._dataSource, Object.assign({}, this._currentRange));
    }

    // 终止加载
    abort() {
        // 终止当前实例的加载器
        this._loader.abort();
        // 如果实例是暂停的，将暂停属性设为 false，并将恢复点设置为 0
        if (this._paused) {
            this._paused = false;
            this._resumeFrom = 0;
        }
    }

    // 用来暂停加载数据
    pause() {
        // 如果当前实例处于工作中
        if (this.isWorking()) {
            // 强行终止当前实例的加载器
            this._loader.abort();
            // 如果当前实例的已使用暂存区不为空
            if (this._stashUsed !== 0) {
                // 将实例的恢复点设置为暂存区起点
                this._resumeFrom = this._stashByteStart;
                // 将实例的当前范围的结尾设置为为暂存区起点 - 1
                this._currentRange.to = this._stashByteStart - 1;
            } else {
                // 将当前实例的恢复点设置为当前范围的结尾 + 1
                this._resumeFrom = this._currentRange.to + 1;
            }
            // 设置实例的已使用暂存区为空
            this._stashUsed = 0;
            // 设置实例的暂存区起点为 0
            this._stashByteStart = 0;
            // 设置实例的暂停属性为 true
            this._paused = true;
        }
    }

    // 恢复暂停加载的实例
    resume() {
        // 如果当前实例处于暂停中
        if (this._paused) {
            // 设置实例的暂停属性为 false
            this._paused = false;
            // 将实例的恢复点存储到一个 bytes 变量里，然后设为 0
            let bytes = this._resumeFrom;
            this._resumeFrom = 0;
            //  将 bytes 传入内部搜索方法中
            this._internalSeek(bytes, true);
        }
    }

    /**
     * 操作数据的有 seek、updateUrl
     */
    // 搜索特定的一段数据
    seek(bytes) {
        // 设置实例的暂停属性为 false
        this._paused = false;
        // 设置实例的已用暂存区为 0
        this._stashUsed = 0;
        // 设置实例的暂存区起点为 0
        this._stashByteStart = 0;
        // 将 bytes 传入内部搜索方法中
        this._internalSeek(bytes, true);
    }

    /**
     * When seeking request is from media seeking, unconsumed stash data should be dropped
     * However, stash data shouldn't be dropped if seeking requested from http reconnection
     *
     * @dropUnconsumed: Ignore and discard all unconsumed data in stash buffer
     */
    /**
     * 内部方法分为数据有关、操作加载器、操作暂存区、事件处理
     * 4.1 数据有关的有 _selectSeekHandler、_internalSeek、_normalizeSpeed、_dispatchChunks
     * 4.2 操作加载器的有 _selectLoader、_createLoader
     * 4.3 操作暂存区的有 _expandBuffer、_adjustStashSize、_flushStashBuffer
     * 4.4 事件处理有 _onContentLengthKnown、_onLoaderChunkArrival、_onLoaderComplete、_onLoaderError
     */

    // 从特定时间点加载数据
    _internalSeek(bytes, dropUnconsumed) {
        // 如果实例的加载器还在工作，终止加载器
        if (this._loader.isWorking()) {
            this._loader.abort();
        }

        // dispatch & flush stash buffer before seek
        // 丢弃未消费数据地刷新暂存区
        this._flushStashBuffer(dropUnconsumed);
        // 销毁实例的加载器
        this._loader.destroy();
        this._loader = null;
        // 新建一个请求范围，起点是传入的 bytes，终点是 -1
        let requestRange = {from: bytes, to: -1};
        // 设置实例的当前数据范围，起点是请求范围的起点，终点是 -1
        this._currentRange = {from: requestRange.from, to: -1};
        // 清空实例的速率、速率计算器
        this._speedSampler.reset();
        // 初始化实例的暂存区大小
        this._stashSize = this._stashInitialSize;
        // 创建一个新的加载器
        this._createLoader();
        // 调用新加载器的 open 方法，传入数据源和请求范围
        this._loader.open(this._dataSource, requestRange);
        // 如果实例对搜索事件有处理函数，调用之
        if (this._onSeeked) {
            this._onSeeked();
        }
    }

    updateUrl(url) {
        if (!url || typeof url !== 'string' || url.length === 0) {
            throw new InvalidArgumentException('Url must be a non-empty string!');
        }

        this._dataSource.url = url;

        // TODO: replace with new url
    }
    // 用来扩展缓存，借鉴了滑动窗口思想
    _expandBuffer(expectedBytes) {
        // 创建新缓存大小，初始值为暂存区大小
        let bufferNewSize = this._stashSize;
        // 只要新缓存大小 + 1M 小于 expectedBytes，就将新缓存大小翻倍
        while (bufferNewSize + 1024 * 1024 * 1 < expectedBytes) {
            bufferNewSize *= 2;
        }
        // 给新缓存大小加 1M
        bufferNewSize += 1024 * 1024 * 1;  // bufferSize = stashSize + 1MB
        // 如果新缓存大小等于实例缓存大小，结束
        if (bufferNewSize === this._bufferSize) {
            return;
        }
        // 创建新缓存，初始化为新缓存大小那么大的一个二进制数组
        let newBuffer = new ArrayBuffer(bufferNewSize);
        // 如果实例的已使用的暂存区不为空
        if (this._stashUsed > 0) {  // copy existing data into new buffer
            // 创建一个老暂存二进制数组，类型为 Uint8Array，指向实例的暂存区缓存，开始于字节0，长度为实例的已使用的暂存区大小
            let stashOldArray = new Uint8Array(this._stashBuffer, 0, this._stashUsed);
            // 创建一个新暂存二进制数组，类型为 Uint8Array，指向新缓存，开始于字节0，长度为新缓存大小
            let stashNewArray = new Uint8Array(newBuffer, 0, bufferNewSize);
            // 拷贝老暂存数组到新暂存数组
            stashNewArray.set(stashOldArray, 0);
        }
        // 将实例的暂存区缓存设置为新缓存
        this._stashBuffer = newBuffer;
        // 将实例的缓存大小设置为新缓存大小
        this._bufferSize = bufferNewSize;
    }
    // 确定加载速度，使用了二分法，类似滑动窗口思想
    _normalizeSpeed(input) {
        // 获取常规速率表，采用二分法确认输入参数 input 应该在表中的哪个位置
        let list = this._speedNormalizeList;
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;
        
        if (input < list[0]) {
            return list[0];
        }
        // 返回常规速率表那个位置的值（比实际值偏小）
        // binary search
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
    // 用来调整暂存区大小
    _adjustStashSize(normalized) {
        // 创建 KB 级的暂存区大小，初始值为 0
        let stashSizeKB = 0;

        // 如果实例配置的实时流属性为 true
        if (this._config.isLive) {
            // live stream: always use single normalized speed for size of stashSizeKB
            // 将 KB 级的暂存区大小设置为 normalized
            stashSizeKB = normalized;
        } else {
            // 如果 normalized 小于 512，将 KB 级的暂存区大小设置为 normalized
            if (normalized < 512) {
                stashSizeKB = normalized;
            } else if (normalized >= 512 && normalized <= 1024) {
                // 如果 normalized 在 [512,1024] 中，将 KB 级的暂存区大小设置为 normalized 的 - 1.5 倍
                stashSizeKB = Math.floor(normalized * 1.5);
            } else {
                // 否则，将 KB 级的暂存区大小设置为 normalized 的 2 倍
                stashSizeKB = normalized * 2;
            }
        }
        // 如果 KB 级的暂存区大小大于 8192，就校正 KB 级的暂存区大小为 8192
        if (stashSizeKB > 8192) {
            stashSizeKB = 8192;
        }
        // 创建缓存大小，初始值为暂存区大小 + 1M
        let bufferSize = stashSizeKB * 1024 + 1024 * 1024 * 1;  // stashSize + 1MB
        // 如果实例的缓存大小小于缓存大小，给实例缓存扩展缓存大小那么多
        if (this._bufferSize < bufferSize) {
            this._expandBuffer(bufferSize);
        }
        // 将实例的暂存区大小设置为暂存区大小
        this._stashSize = stashSizeKB * 1024;
    }
    // 是分派加载完数据的函数，参数为数据块和数据起点
    _dispatchChunks(chunks, byteStart) {
        // 将实例的当前范围的终点设置为数据起点 + 数据块大小 - 1
        this._currentRange.to = byteStart + chunks.byteLength - 1;
        // 调用实例的数据到达事件处理函数
        return this._onDataArrival(chunks, byteStart);
    }

    _onURLRedirect(redirectedURL) {
        this._redirectedURL = redirectedURL;
        if (this._onRedirect) {
            this._onRedirect(redirectedURL);
        }
    }
    // 处理已知内容长度事件
    _onContentLengthKnown(contentLength) {
        // 如果 contentLength 存在并且实例的全请求标志为真
        if (contentLength && this._fullRequestFlag) {
            // 设置实例的数据总长度为 contentLength
            this._totalLength = contentLength;
            // 设置实例的全请求标志为假
            this._fullRequestFlag = false;
        }
    }

    // 处理数据到达事件
    _onLoaderChunkArrival(chunk, byteStart, receivedLength) {
        // 如果实例没有处理数据到达事件的函数，报错
        if (!this._onDataArrival) {
            throw new IllegalStateException('IOController: No existing consumer (onDataArrival) callback!');
        }
        //  如果实例的暂停属性为 true，结束
        if (this._paused) {
            return;
        }
        // 如果实例的过早结束属性为 true，将之设置为 false。如果实例存在接收过早结束函数，调用之。
        if (this._isEarlyEofReconnecting) {
            // Auto-reconnect for EarlyEof succeed, notify to upper-layer by callback
            this._isEarlyEofReconnecting = false;
            if (this._onRecoveredEarlyEof) {
                this._onRecoveredEarlyEof();
            }
        }

        // 实例的速率计算器增加 chunk 字节长度那么多的字节
        this._speedSampler.addBytes(chunk.byteLength);

        // adjust stash buffer size according to network speed dynamically
        // 根据速率动态调整存储缓冲区大小
        let KBps = this._speedSampler.lastSecondKBps;
        if (KBps !== 0) {
            let normalized = this._normalizeSpeed(KBps);
            if (this._speedNormalized !== normalized) {
                this._speedNormalized = normalized;
                this._adjustStashSize(normalized);
            }
        }
        // 如果实例的允许暂存区为 false
        if (!this._enableStash) {  // disable stash
            // 如果实例的已使用暂存区为空
            if (this._stashUsed === 0) {
                // dispatch chunk directly to consumer;
                // check ret value (consumed bytes) and stash unconsumed to stashBuffer
                // 直接将数据分派给消费者
                let consumed = this._dispatchChunks(chunk, byteStart);
                // 如果已消费数据长度小于 chunk 字节长度
                if (consumed < chunk.byteLength) {  // unconsumed data remain.
                    // 创建未消费长度，初始值为 chunk 字节长度 - 已消费长度
                    let remain = chunk.byteLength - consumed;
                    if (remain > this._bufferSize) {
                        // 如果未消费长度大于实例的缓存大小，扩展实例缓存
                        this._expandBuffer(remain);
                    }
                    // 创建暂存区数组，Uint8Array 类型，指向实例的暂存区缓存，起点为 0，长度为实例的缓存大小
                    let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                    // 创建已消费数组，Uint8Array 类型，指向 chunk，起点为已消费长度，拷贝到暂存区数组里去
                    stashArray.set(new Uint8Array(chunk, consumed), 0);
                    // 将实例的已使用暂存区长度加上剩余长度
                    this._stashUsed += remain;
                    // 设置暂存区起点为 byteStart + 已消费长度
                    this._stashByteStart = byteStart + consumed;
                }
            } else {
                // else: Merge chunk into stashBuffer, and dispatch stashBuffer to consumer.
                // 否则将 chunk 合并到暂存区缓存中，并将暂存区缓存分派给使用者
                // 如果实例的已使用暂存区大小 + chunk 字节长度 > 实例的缓存大小，扩展实例缓存
                if (this._stashUsed + chunk.byteLength > this._bufferSize) {
                    this._expandBuffer(this._stashUsed + chunk.byteLength);
                }
                // 创建暂存区数组，Uint8Array 类型，指向实例的暂存区缓存，起点为 0，长度为实例的缓存大小
                let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                // 创建 chunk 数组，Uint8Array 类型，指向 chunk ，拷贝到暂存区数组里去
                stashArray.set(new Uint8Array(chunk), this._stashUsed);
                // 将实例的已使用暂存区长度加上 chunk 字节长度
                this._stashUsed += chunk.byteLength;
                // 创建已消费长度，初始化为实例暂存缓存从 0 到实例已使用暂存区长度那么多，分派之
                let consumed = this._dispatchChunks(this._stashBuffer.slice(0, this._stashUsed), this._stashByteStart);
                // 如果已消费长度小于实例已使用暂存区长度且已消费长度 > 0
                if (consumed < this._stashUsed && consumed > 0) {  // unconsumed data remain
                    // 新建剩余数组，Uint8Array 类型，指向实例的暂存缓存，起点为已消费长度
                    let remainArray = new Uint8Array(this._stashBuffer, consumed);
                    // 拷贝剩余数组到暂存数组去
                    stashArray.set(remainArray, 0);
                }
                // 将实例的已使用暂存长度减去已消费长度
                this._stashUsed -= consumed;
                // 将暂存区起点加上已消费长度
                this._stashByteStart += consumed;
            }
        } else {  // enable stash
            // 如果实例的已用暂存区为空且实例的暂存区起点为 0，将实例的暂存区设为 byteStart
            if (this._stashUsed === 0 && this._stashByteStart === 0) {  // seeked? or init chunk?
                // This is the first chunk after seek action
                this._stashByteStart = byteStart;
            }
            // 如果实例的已用暂存区长度 + chunk 参数字节长度 <= 实例的暂存区长度
            if (this._stashUsed + chunk.byteLength <= this._stashSize) {
                // just stash
                // 创建暂存区数组，Uint8Array 类型，指向实例的暂存区缓存，起点为 0，长度为实例的暂存区大小
                let stashArray = new Uint8Array(this._stashBuffer, 0, this._stashSize);
                // 新建 chunk 数组，Uint8Array 类型，指向 chunk 参数，起点为已用暂存区长度，拷贝到暂存区数组去
                stashArray.set(new Uint8Array(chunk), this._stashUsed);
                // 将实例的已用暂存长度加上 chunk 参数的字节长度
                this._stashUsed += chunk.byteLength;
            } else { // 否则，chunk 太大了，发送整个暂存区缓存，并保留数据，然后将块添加到暂存区缓存
                // 创建暂存区数组，Uint8Array 类型，指向实例的暂存区缓存，起点为 0，长度为缓存大小
                let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                // 如果实例的已用暂存不为空
                if (this._stashUsed > 0) {  // There're stash datas in buffer
                    // dispatch the whole stashBuffer, and stash remain data
                    // then append chunk to stashBuffer (stash)
                    // 创建缓存，初始值为实例暂存缓存从 0 到实例的已用暂存长度这么多
                    let buffer = this._stashBuffer.slice(0, this._stashUsed);
                    // 创建已消费长度，初始值为从实例暂存起点分发缓存这么多
                    let consumed = this._dispatchChunks(buffer, this._stashByteStart);
                    // 如果已消费长度 < 缓存字节长度
                    if (consumed < buffer.byteLength) {
                        // 如果已消费长度 > 0
                        if (consumed > 0) {
                            // 创建剩余数组，Uint8Array 类型，指向缓存，起点为已消费长度，拷贝到暂存区数组去
                            let remainArray = new Uint8Array(buffer, consumed);
                            stashArray.set(remainArray, 0);
                            // 将实例已用暂存长度设为剩余数组字节长度
                            this._stashUsed = remainArray.byteLength;
                            // 将暂存起点加上消费长度
                            this._stashByteStart += consumed;
                        }
                    } else {
                        // 否则，将实例已用暂存长度设为 0，将暂存起点加上消费长度
                        this._stashUsed = 0;
                        this._stashByteStart += consumed;
                    }
                    // 如果实例已用暂存长度 + chunk 字节长度 > 实例缓存大小
                    if (this._stashUsed + chunk.byteLength > this._bufferSize) {
                        // 扩展缓存
                        this._expandBuffer(this._stashUsed + chunk.byteLength);
                        // 重设暂存区数组，Uint8Array 类型，指向实例的暂存区缓存，起点为 0，长度为缓存大小
                        stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                    }
                    //  创建 chunk 数组，Uint8Array 类型，指向 chunk ，起点为实例已用暂存长度，拷贝到暂存区数组去
                    stashArray.set(new Uint8Array(chunk), this._stashUsed);
                    // 将实例已用暂存长度加上 chunk 的字节长度
                    this._stashUsed += chunk.byteLength;
                } else {  // stash buffer empty, but chunkSize > stashSize (oh, holy shit)
                    // dispatch chunk directly and stash remain data
                    // 否则，存储缓冲区为空，但是 chunk 大小 > 暂存区大小，直接派发块并保留数据
                    let consumed = this._dispatchChunks(chunk, byteStart);
                    // 如果已消费长度 < chunk 字节长度
                    if (consumed < chunk.byteLength) {
                        // 创建剩余长度，初始值为 chunk 字节长度 - 已消费长度
                        let remain = chunk.byteLength - consumed;
                        if (remain > this._bufferSize) {
                            // 如果剩余长度 > 实例缓存大小，扩展缓存，并创建暂存区数组，Uint8Array 类型，指向实例的暂存区缓存，起点为 0，长度为缓存大小
                            this._expandBuffer(remain);
                            stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                        }
                        // 创建 chunk 数组，Uint8Array 类型，指向 chunk ，起点为已消费长度，拷贝到暂存区数组去
                        stashArray.set(new Uint8Array(chunk, consumed), 0);
                        // 将实例已使用暂存区长度加上剩余长度
                        this._stashUsed += remain;
                        // 将实例暂存区起点设为 byteStart + 消费长度
                        this._stashByteStart = byteStart + consumed;
                    }
                }
            }
        }
    }

    // 用来刷新暂存区和缓存
    _flushStashBuffer(dropUnconsumed) {
        // 如果实例的已使用缓存区不为空
        if (this._stashUsed > 0) {
            // 创建缓存，初始化为实例的暂存区缓存从 0 到已使用缓存大小
            let buffer = this._stashBuffer.slice(0, this._stashUsed);
            // 创建已消费长度，初始化为加载完缓存(从实例的暂存起点)后的处理函数返回的结果
            let consumed = this._dispatchChunks(buffer, this._stashByteStart);
            // 创建剩余长度，初始化为缓存占据的内存字节长度 - 已消费长度
            let remain = buffer.byteLength - consumed;
            // 如果已消费长度小于缓存占据的内存字节长度
            if (consumed < buffer.byteLength) {
                // 如果要丢弃未消费数据（dropUnconsumed 为 true），打印一句日志告诉用户丢弃了多少剩余长度的数据
                if (dropUnconsumed) {
                    Log.w(this.TAG, `${remain} bytes unconsumed data remain when flush buffer, dropped`);
                } else {
                     // 如果已消费长度大于 0
                    if (consumed > 0) {
                        // 创建暂存二进制数组，Uint8Array 类型，指向实例的暂存区缓存，开始于字节0，长度为实例的缓存大小
                        let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                        // 创建剩余二进制数组，Uint8Array 类型，指向实例的暂存区缓存，开始于已消费长度
                        let remainArray = new Uint8Array(buffer, consumed);
                        // 拷贝剩余数组到暂存区数据中
                        stashArray.set(remainArray, 0);
                        // 设置实例的已使用暂存区大小为剩余数组的内存字节长度
                        this._stashUsed = remainArray.byteLength;
                        // 给实例的暂存起点增加已消费长度
                        this._stashByteStart += consumed;
                    }
                    return 0;
                }
            }
            this._stashUsed = 0;
            this._stashByteStart = 0;
            return remain;
        }
        return 0;
    }

    /**
     * 事件处理有 _onContentLengthKnown、_onLoaderChunkArrival、_onLoaderComplete、_onLoaderError
     * */

    // 处理数据加载完成事件
    _onLoaderComplete(from, to) {
        // Force-flush stash buffer, and drop unconsumed data
        // 以丢弃未消费数据模式刷新暂存区和缓存
        this._flushStashBuffer(true);
        // 如果实例的完成事件有监听函数，调用之，传入实例的提取数据
        if (this._onComplete) {
            this._onComplete(this._extraData);
        }
    }
    // 处理数据加载错误事件
    _onLoaderError(type, data) {
        Log.e(this.TAG, `Loader error, code = ${data.code}, msg = ${data.msg}`);
        // 以保留未消费数据模式刷新暂存区和缓存
        this._flushStashBuffer(false);
        // 如果实例的过早结束属性为 true
        if (this._isEarlyEofReconnecting) {
            // Auto-reconnect for EarlyEof failed, throw UnrecoverableEarlyEof error to upper-layer
            this._isEarlyEofReconnecting = false;
            // 如果实例的过早结束属性为 true
            type = LoaderErrors.UNRECOVERABLE_EARLY_EOF;
        }
        // 判断type
        switch (type) {
            // type 是过早结束
            case LoaderErrors.EARLY_EOF: {
                // 如果实例配置的实时流属性为 false
                if (!this._config.isLive) {
                    // Do internal http reconnect if not live stream
                    if (this._totalLength) {
                        // 如果实例的数据总长度存在
                        // 创建下一个起点，初始化为实例的当前范围的终点 + 1
                        let nextFrom = this._currentRange.to + 1;
                        // 如果下一个起点小于实例的数据总长度，设置实例的过早结束属性为 true，调用不丢弃未消费数据的内部搜索方法，传入下一个起点
                        if (nextFrom < this._totalLength) {
                            Log.w(this.TAG, 'Connection lost, trying reconnect...');
                            this._isEarlyEofReconnecting = true;
                            this._internalSeek(nextFrom, false);
                        }
                        return;
                    }
                    // else: We don't know totalLength, throw UnrecoverableEarlyEof
                }
                // live stream: throw UnrecoverableEarlyEof error to upper-layer
                // 设置 type 为加载器错误的接收过早结束
                type = LoaderErrors.UNRECOVERABLE_EARLY_EOF;
                break;
            }
            // type 是接收过早结束、连接超时、HTTP 状态码无效、其他：跳过
            case LoaderErrors.UNRECOVERABLE_EARLY_EOF:
            case LoaderErrors.CONNECTING_TIMEOUT:
            case LoaderErrors.HTTP_STATUS_CODE_INVALID:
            case LoaderErrors.EXCEPTION:
                break;
        }
        // 如果实例的错误事件有监听函数，调用之，传入 type 和 data
        if (this._onError) {
            this._onError(type, data);
        } else {
            // 否则报 IOException 错误
            throw new RuntimeException('IOException: ' + data.msg);
        }
    }

}

export default IOController;