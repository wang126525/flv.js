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

import EventEmitter from 'events';
import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import MediaInfo from './media-info.js';
import FLVDemuxer from '../demux/flv-demuxer.js';
import MP4Remuxer from '../remux/mp4-remuxer.js';
import DemuxErrors from '../demux/demux-errors.js';
import IOController from '../io/io-controller.js';
import TransmuxingEvents from './transmuxing-events.js';
import {LoaderStatus, LoaderErrors} from '../io/loader.js';

// Transmuxing (IO, Demuxing, Remuxing) controller, with multipart support
class TransmuxingController {

    constructor(mediaDataSource, config) {
        this.TAG = 'TransmuxingController';
        this._emitter = new EventEmitter();

        this._config = config;

        // treat single part media as multipart media, which has only one segment
        // 将单部分媒体视为只有一个分段的多部分媒体
        if (!mediaDataSource.segments) {
            mediaDataSource.segments = [{
                duration: mediaDataSource.duration,
                filesize: mediaDataSource.filesize,
                url: mediaDataSource.url
            }];
        }

        // fill in default IO params if not exists
        // 如果不存在，请填写默认的IO参数
        if (typeof mediaDataSource.cors !== 'boolean') {
            mediaDataSource.cors = true;
        }
        if (typeof mediaDataSource.withCredentials !== 'boolean') {
            mediaDataSource.withCredentials = false;
        }

        this._mediaDataSource = mediaDataSource;
        this._currentSegmentIndex = 0;
        let totalDuration = 0;

        this._mediaDataSource.segments.forEach((segment) => {
            // timestampBase for each segment, and calculate total duration
            // 每个段的timestampBase，并计算总持续时间
            segment.timestampBase = totalDuration;
            totalDuration += segment.duration;
            // params needed by IOController
            // IOController需要的参数
            segment.cors = mediaDataSource.cors;
            segment.withCredentials = mediaDataSource.withCredentials;
            // referrer policy control, if exist
            if (config.referrerPolicy) {
                segment.referrerPolicy = config.referrerPolicy;
            }
        });

        if (!isNaN(totalDuration) && this._mediaDataSource.duration !== totalDuration) {
            this._mediaDataSource.duration = totalDuration;
        }

        this._mediaInfo = null;
        this._demuxer = null;
        this._remuxer = null;
        this._ioctl = null;

        this._pendingSeekTime = null;
        this._pendingResolveSeekPoint = null;

        this._statisticsReporter = null;
    }

    destroy() {
        this._mediaInfo = null;
        this._mediaDataSource = null;

        if (this._statisticsReporter) {
            this._disableStatisticsReporter();
        }
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
        if (this._demuxer) {
            this._demuxer.destroy();
            this._demuxer = null;
        }
        if (this._remuxer) {
            this._remuxer.destroy();
            this._remuxer = null;
        }

        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    on(event, listener) {
        this._emitter.addListener(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }
    // 开始加载数据 拉流
    start() {
        this._loadSegment(0);
        this._enableStatisticsReporter();
    }

    _loadSegment(segmentIndex, optionalFrom) {
        this._currentSegmentIndex = segmentIndex;
        let dataSource = this._mediaDataSource.segments[segmentIndex];
        //  实例化IOController 处理flv数据流的拉取  构造函数里执行了选择搜索处理函数、选择加载器、创建加载器的操作
        let ioctl = this._ioctl = new IOController(dataSource, this._config, segmentIndex);
        ioctl.onError = this._onIOException.bind(this);
        ioctl.onSeeked = this._onIOSeeked.bind(this);
        ioctl.onComplete = this._onIOComplete.bind(this);
        ioctl.onRedirect = this._onIORedirect.bind(this);
        ioctl.onRecoveredEarlyEof = this._onIORecoveredEarlyEof.bind(this);

        if (optionalFrom) {
            this._demuxer.bindDataSource(this._ioctl);
        } else {
            // 第一次得到数据时 绑定数据源下载传输的函数 比如fetch-stream-loader.js里面请求的数据就通过这个方法导出 
            ioctl.onDataArrival = this._onInitChunkArrival.bind(this);
        }

        ioctl.open(optionalFrom);
    }

    stop() {
        this._internalAbort();
        this._disableStatisticsReporter();
    }

    _internalAbort() {
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
    }

    pause() {  // take a rest
        if (this._ioctl && this._ioctl.isWorking()) {
            this._ioctl.pause();
            this._disableStatisticsReporter();
        }
    }

    resume() {
        if (this._ioctl && this._ioctl.isPaused()) {
            this._ioctl.resume();
            this._enableStatisticsReporter();
        }
    }

    seek(milliseconds) {
        if (this._mediaInfo == null || !this._mediaInfo.isSeekable()) {
            return;
        }

        let targetSegmentIndex = this._searchSegmentIndexContains(milliseconds);

        if (targetSegmentIndex === this._currentSegmentIndex) {
            // intra-segment seeking
            let segmentInfo = this._mediaInfo.segments[targetSegmentIndex];

            if (segmentInfo == undefined) {
                // current segment loading started, but mediainfo hasn't received yet
                // wait for the metadata loaded, then seek to expected position
                // 当前段加载已经开始，但是mediainfo还没有收到   等待元数据加载，然后寻找到预期的位置
                this._pendingSeekTime = milliseconds;
            } else {
                let keyframe = segmentInfo.getNearestKeyframe(milliseconds);
                this._remuxer.seek(keyframe.milliseconds);
                this._ioctl.seek(keyframe.fileposition);
                // Will be resolved in _onRemuxerMediaSegmentArrival()
                // 将在_onRemuxerMediaSegmentArrival()中解析
                this._pendingResolveSeekPoint = keyframe.milliseconds;
            }
        } else {
            // cross-segment seeking
            let targetSegmentInfo = this._mediaInfo.segments[targetSegmentIndex];

            if (targetSegmentInfo == undefined) {
                // target segment hasn't been loaded. We need metadata then seek to expected time
                // 目标段尚未加载。我们需要元数据，然后寻找预期的时间
                this._pendingSeekTime = milliseconds;
                this._internalAbort();
                this._remuxer.seek();
                this._remuxer.insertDiscontinuity();
                this._loadSegment(targetSegmentIndex);
                // Here we wait for the metadata loaded, then seek to expected position
                // 在这里，我们等待元数据加载，然后寻找到预期的位置
            } else {
                // We have target segment's metadata, direct seek to target position
                // 我们有目标细分的元数据，直接寻找目标位置
                
                let keyframe = targetSegmentInfo.getNearestKeyframe(milliseconds);
                this._internalAbort();
                this._remuxer.seek(milliseconds);
                this._remuxer.insertDiscontinuity();
                this._demuxer.resetMediaInfo();
                this._demuxer.timestampBase = this._mediaDataSource.segments[targetSegmentIndex].timestampBase;
                this._loadSegment(targetSegmentIndex, keyframe.fileposition);
                this._pendingResolveSeekPoint = keyframe.milliseconds;
                this._reportSegmentMediaInfo(targetSegmentIndex);
            }
        }

        this._enableStatisticsReporter();
    }

    _searchSegmentIndexContains(milliseconds) {
        let segments = this._mediaDataSource.segments;
        let idx = segments.length - 1;

        for (let i = 0; i < segments.length; i++) {
            if (milliseconds < segments[i].timestampBase) {
                idx = i - 1;
                break;
            }
        }
        return idx;
    }
    /**
     * flv数据解析
     * @param {*} data 
     * @param {*} byteStart 
     */
    _onInitChunkArrival(data, byteStart) {
        let probeData = null;
        let consumed = 0;
        // debugger
        if (byteStart > 0) {
            // IOController seeked immediately after opened, byteStart > 0 callback may received
            this._demuxer.bindDataSource(this._ioctl);
            this._demuxer.timestampBase = this._mediaDataSource.segments[this._currentSegmentIndex].timestampBase;

            consumed = this._demuxer.parseChunks(data, byteStart);
        } else if ((probeData = FLVDemuxer.probe(data)).match) {
            // Always create new FLVDemuxer
            this._demuxer = new FLVDemuxer(probeData, this._config);

            if (!this._remuxer) {
                this._remuxer = new MP4Remuxer(this._config);
            }

            let mds = this._mediaDataSource;
            if (mds.duration != undefined && !isNaN(mds.duration)) {
                this._demuxer.overridedDuration = mds.duration;
            }
            if (typeof mds.hasAudio === 'boolean') {
                this._demuxer.overridedHasAudio = mds.hasAudio;
            }
            if (typeof mds.hasVideo === 'boolean') {
                this._demuxer.overridedHasVideo = mds.hasVideo;
            }

            this._demuxer.timestampBase = mds.segments[this._currentSegmentIndex].timestampBase;

            // 给解码器绑定系列方法 得到解码后的数据
            this._demuxer.onError = this._onDemuxException.bind(this);
            // 监听媒体信息的解析 包含scriptData video audio 里面的信息 更新信息
            this._demuxer.onMediaInfo = this._onMediaInfo.bind(this);
            // 将解析的数据抛出 onMetaData 在scriptData里面
            this._demuxer.onMetaDataArrived = this._onMetaDataArrived.bind(this);
            // 解析scriptData数据的回调 并将解析后的scriptData数据抛出
            this._demuxer.onScriptDataArrived = this._onScriptDataArrived.bind(this);
            // this._demuxer.bindDataSource(this._ioctl) 返回的是当前的解码器实例 this._demuxer 解码器内会调用回调方法将解码完的数据作为参数传入
            // 核心 该回调在MP4-remuxer.js中实现 onDataAvailable音视频帧数据 this._onDataAvailable(this._audioTrack, this._videoTrack);  onTrackMetadata音视频元数据 this._onTrackMetadata('audio', meta);
            this._remuxer.bindDataSource(this._demuxer.bindDataSource(this._ioctl));



            // 核心 绑定通过 MP4编码后的数据回调  并通过回调将编码后的MP4数据抛给mse-controller.js 塞到MediaSource中 播放
            this._remuxer.onInitSegment = this._onRemuxerInitSegmentArrival.bind(this);
            this._remuxer.onMediaSegment = this._onRemuxerMediaSegmentArrival.bind(this);

            consumed = this._demuxer.parseChunks(data, byteStart);
        } else {
            probeData = null;
            Log.e(this.TAG, 'Non-FLV, Unsupported media type!');
            Promise.resolve().then(() => {
                this._internalAbort();
            });
            this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, DemuxErrors.FORMAT_UNSUPPORTED, 'Non-FLV, Unsupported media type');

            consumed = 0;
        }

        return consumed;
    }

    _onMediaInfo(mediaInfo) {
        if (this._mediaInfo == null) {
            // Store first segment's mediainfo as global mediaInfo
            this._mediaInfo = Object.assign({}, mediaInfo);
            this._mediaInfo.keyframesIndex = null;
            this._mediaInfo.segments = [];
            this._mediaInfo.segmentCount = this._mediaDataSource.segments.length;
            Object.setPrototypeOf(this._mediaInfo, MediaInfo.prototype);
        }

        let segmentInfo = Object.assign({}, mediaInfo);
        Object.setPrototypeOf(segmentInfo, MediaInfo.prototype);
        this._mediaInfo.segments[this._currentSegmentIndex] = segmentInfo;

        // notify mediaInfo update
        this._reportSegmentMediaInfo(this._currentSegmentIndex);

        if (this._pendingSeekTime != null) {
            Promise.resolve().then(() => {
                let target = this._pendingSeekTime;
                this._pendingSeekTime = null;
                this.seek(target);
            });
        }
    }

    _onMetaDataArrived(metadata) {
        this._emitter.emit(TransmuxingEvents.METADATA_ARRIVED, metadata);
    }

    _onScriptDataArrived(data) {
        this._emitter.emit(TransmuxingEvents.SCRIPTDATA_ARRIVED, data);
    }

    _onIOSeeked() {
        this._remuxer.insertDiscontinuity();
    }

    _onIOComplete(extraData) {
        let segmentIndex = extraData;
        let nextSegmentIndex = segmentIndex + 1;

        if (nextSegmentIndex < this._mediaDataSource.segments.length) {
            this._internalAbort();
            this._remuxer.flushStashedSamples();
            this._loadSegment(nextSegmentIndex);
        } else {
            this._remuxer.flushStashedSamples();
            this._emitter.emit(TransmuxingEvents.LOADING_COMPLETE);
            this._disableStatisticsReporter();
        }
    }

    _onIORedirect(redirectedURL) {
        let segmentIndex = this._ioctl.extraData;
        this._mediaDataSource.segments[segmentIndex].redirectedURL = redirectedURL;
    }

    _onIORecoveredEarlyEof() {
        this._emitter.emit(TransmuxingEvents.RECOVERED_EARLY_EOF);
    }

    _onIOException(type, info) {
        Log.e(this.TAG, `IOException: type = ${type}, code = ${info.code}, msg = ${info.msg}`);
        this._emitter.emit(TransmuxingEvents.IO_ERROR, type, info);
        this._disableStatisticsReporter();
    }

    _onDemuxException(type, info) {
        Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
        this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, type, info);
    }

    _onRemuxerInitSegmentArrival(type, initSegment) {
        this._emitter.emit(TransmuxingEvents.INIT_SEGMENT, type, initSegment);
    }

    _onRemuxerMediaSegmentArrival(type, mediaSegment) {
        if (this._pendingSeekTime != null) {
            // Media segments after new-segment cross-seeking should be dropped.
            // 新片段交叉搜索后的媒体片段应该被删除。
            return;
        }
        this._emitter.emit(TransmuxingEvents.MEDIA_SEGMENT, type, mediaSegment);

        // Resolve pending seekPoint
        if (this._pendingResolveSeekPoint != null && type === 'video') {
            let syncPoints = mediaSegment.info.syncPoints;
            let seekpoint = this._pendingResolveSeekPoint;
            this._pendingResolveSeekPoint = null;

            // Safari: Pass PTS for recommend_seekpoint
            if (Browser.safari && syncPoints.length > 0 && syncPoints[0].originalDts === seekpoint) {
                seekpoint = syncPoints[0].pts;
            }
            // else: use original DTS (keyframe.milliseconds)

            this._emitter.emit(TransmuxingEvents.RECOMMEND_SEEKPOINT, seekpoint);
        }
    }

    _enableStatisticsReporter() {
        if (this._statisticsReporter == null) {
            this._statisticsReporter = self.setInterval(
                this._reportStatisticsInfo.bind(this),
            this._config.statisticsInfoReportInterval);
        }
    }

    _disableStatisticsReporter() {
        if (this._statisticsReporter) {
            self.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    _reportSegmentMediaInfo(segmentIndex) {
        let segmentInfo = this._mediaInfo.segments[segmentIndex];
        let exportInfo = Object.assign({}, segmentInfo);

        exportInfo.duration = this._mediaInfo.duration;
        exportInfo.segmentCount = this._mediaInfo.segmentCount;
        delete exportInfo.segments;
        delete exportInfo.keyframesIndex;

        this._emitter.emit(TransmuxingEvents.MEDIA_INFO, exportInfo);
    }

    _reportStatisticsInfo() {
        let info = {};

        info.url = this._ioctl.currentURL;
        info.hasRedirect = this._ioctl.hasRedirect;
        if (info.hasRedirect) {
            info.redirectedURL = this._ioctl.currentRedirectedURL;
        }

        info.speed = this._ioctl.currentSpeed;
        info.loaderType = this._ioctl.loaderType;
        info.currentSegmentIndex = this._currentSegmentIndex;
        info.totalSegmentCount = this._mediaDataSource.segments.length;

        this._emitter.emit(TransmuxingEvents.STATISTICS_INFO, info);
    }

}

export default TransmuxingController;