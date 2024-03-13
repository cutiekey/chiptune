import _libopenmpt, { type MainModule } from './libopenmpt.js'

export interface IProcessNode extends ScriptProcessorNode {
  cleanup(): void
  config: ChiptuneJsConfig
  getProcessTime(): IProcessNode['perf']
  leftBufferPtr: number
  modulePtr: number
  nbChannels: number
  patternIndex: number
  pause(): void
  paused: boolean
  perf: { current: number; max: number }
  player: ChiptuneJsPlayer
  rightBufferPtr: number
  stop(): void
  togglePause(): void
  unpause(): void
}

const libopenmpt = _libopenmpt as MainModule

export class ChiptuneAudioContext extends AudioContext {}

export class ChiptuneJsConfig {
  public context?: ChiptuneAudioContext
  public repeatCount: number

  constructor(
    repeatCount: number,
    context?: ChiptuneAudioContext
  ) {
    this.context = context
    this.repeatCount = repeatCount
  }
}

export class ChiptuneJsPlayer {
  public audioContext: ChiptuneAudioContext
  public config: ChiptuneJsConfig
  public context: GainNode
  public currentPlayingNode?: IProcessNode
  public handlers: { eventName: string; handler: (...args: any[]) => void }[]
  public touchLocked: boolean
  public volume: number

  constructor(config: ChiptuneJsConfig) {
    this.audioContext = config.context || new ChiptuneAudioContext()
    this.config = config
    this.context = this.audioContext.createGain()
    this.handlers = []
    this.touchLocked = true
    this.volume = 1
  }

  public addHandler(eventName: string, handler: (...args: any[]) => void) {
    this.handlers.push({ eventName, handler })
  }

  public createLibopenmptNode(buffer: ArrayBuffer, config: ChiptuneJsConfig) {
    let maxFramesPerChunk = 4096
    let processNode = this.audioContext.createScriptProcessor(
      2048,
      0,
      2
    ) as IProcessNode

    processNode.config = config
    processNode.player = this

    let byteArray = new Int8Array(buffer)
    let ptrToFile = libopenmpt._malloc(byteArray.byteLength)

    libopenmpt.HEAPU8.set(byteArray, ptrToFile)

    processNode.cleanup = function() {
      if (this.modulePtr !== 0) {
        libopenmpt._openmpt_module_destroy(this.modulePtr)

        this.modulePtr = 0
      }

      if (this.leftBufferPtr !== 0) {
        libopenmpt._free(this.leftBufferPtr)

        this.leftBufferPtr = 0
      }

      if (this.rightBufferPtr !== 0) {
        libopenmpt._free(this.rightBufferPtr)

        this.rightBufferPtr = 0
      }
    }

    processNode.getProcessTime = function() {
      const max = this.perf.max

      this.perf.max = 0

      return {
        current: this.perf.current,
        max
      }
    }

    processNode.leftBufferPtr = libopenmpt._malloc(maxFramesPerChunk * 4)

    processNode.modulePtr = libopenmpt._openmpt_module_create_from_memory(
      ptrToFile,
      byteArray.byteLength,
      0,
      0,
      0
    )

    processNode.nbChannels = libopenmpt._openmpt_module_get_num_channels(
      processNode.modulePtr
    )

    processNode.onaudioprocess = function(
      this: IProcessNode,
      ev: AudioProcessingEvent
    ) {
      let startTimeP1 = performance.now()

      let outputL = ev.outputBuffer.getChannelData(0)
      let outputR = ev.outputBuffer.getChannelData(1)

      let framesToRender = outputL.length

      if (this.modulePtr === 0) {
        for (let i = 0; i < framesToRender; ++i) {
          outputL[i] = 0
          outputR[i] = 0
        }

        this.disconnect()
        this.cleanup()

        return
      }

      if (this.paused) {
        for (let i = 0; i < framesToRender; ++i) {
          outputL[i] = 0
          outputR[i] = 0
        }

        return
      }

      let ended = false
      let error = false
      let framesRendered = 0

      let currentPattern = libopenmpt._openmpt_module_get_current_pattern(
        this.modulePtr
      )

      let currentRow = libopenmpt._openmpt_module_get_current_row(
        this.modulePtr
      )

      startTimeP1 -= performance.now()

      if (currentPattern !== this.patternIndex) {
        processNode.player.fireEvent('onPatternChange')
      }

      processNode.player.fireEvent('onRowChange', { index: currentRow })

      let startTimeP2 = performance.now()

      while (framesToRender > 0) {
        let framesPerChunk = Math.min(framesToRender, maxFramesPerChunk)

        let actualFramesPerChunk = libopenmpt._openmpt_module_read_float_stereo(
          this.modulePtr,
          this.context.sampleRate,
          framesPerChunk,
          this.leftBufferPtr,
          this.rightBufferPtr
        )

        if (actualFramesPerChunk === 0) {
          ended = true
          error = !this.modulePtr
        }

        let rawAudioLeft = libopenmpt.HEAPF32.subarray(
          this.leftBufferPtr / 4,
          (this.leftBufferPtr / 4) + actualFramesPerChunk
        )

        let rawAudioRight = libopenmpt.HEAPF32.subarray(
          this.rightBufferPtr / 4,
          (this.rightBufferPtr / 4) + actualFramesPerChunk
        )

        for (let i = 0; i < actualFramesPerChunk; ++i) {
          outputL[framesRendered + i] = rawAudioLeft[i]!
          outputR[framesRendered + i] = rawAudioRight[i]!
        }

        for (let i = actualFramesPerChunk; i < framesPerChunk; ++i) {
          outputL[framesRendered + i] = 0
          outputR[framesRendered + i] = 0
        }

        framesRendered += framesPerChunk
        framesToRender -= framesPerChunk
      }

      if (ended) {
        this.disconnect()
        this.cleanup()

        error
          ? processNode.player.fireEvent('onError', { type: 'openmpt' })
          : processNode.player.fireEvent('onEnded')
      }

      this.perf.current = performance.now() - startTimeP2 + startTimeP1

      if (this.perf.current > this.perf.max) {
        this.perf.max = this.perf.current
      }
    } as any

    processNode.patternIndex = -1

    processNode.pause = function() {
      this.paused = true
    }

    processNode.paused = false

    processNode.perf = {
      current: 0,
      max: 0
    }

    processNode.rightBufferPtr = libopenmpt._malloc(maxFramesPerChunk * 4)

    processNode.stop = function() {
      this.disconnect()
      this.cleanup()
    }

    processNode.togglePause = function() {
      this.paused = !this.paused
    }

    processNode.unpause = function() {
      this.paused = false
    }

    return processNode
  }

  public duration() {
    return libopenmpt._openmpt_module_get_duration_seconds(
      this.currentPlayingNode!.modulePtr
    )
  }

  public fireEvent(eventName: string, response?: any) {
    if (this.handlers.length) {
      this.handlers.forEach(handler => {
        if (handler.eventName === eventName) {
          handler.handler(response)
        }
      })
    }
  }

  public getCtls() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_ctls(
        this.currentPlayingNode.modulePtr
      )
    }

    return 0
  }

  public getCurrentSpeed() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_current_speed(
        this.currentPlayingNode.modulePtr
      )
    }

    return 0
  }

  public getCurrentTempo() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_current_tempo(
        this.currentPlayingNode.modulePtr
      )
    }

    return 0
  }

  public getNumPatterns() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_num_patterns(
        this.currentPlayingNode.modulePtr
      )
    }

    return 0
  }

  public getPattern() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_current_pattern(
        this.currentPlayingNode.modulePtr
      )
    }

    return 0
  }

  public getPatternNumRows(pattern: number) {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_pattern_num_rows(
        this.currentPlayingNode.modulePtr,
        pattern
      )
    }

    return 0
  }

  public getPatternRowChannel(pattern: number, row: number, channel: number) {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt.UTF8ToString(
        libopenmpt._openmpt_module_format_pattern_row_channel(
          this.currentPlayingNode.modulePtr,
          pattern,
          row,
          channel,
          0,
          (true as any)
        )
      )
    }

    return ''
  }

  public getRow() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_module_get_current_row(
        this.currentPlayingNode.modulePtr
      )
    }

    return 0
  }

  public load(input: File | string) {
    return new Promise<ArrayBuffer>((res, rej) => {
      if (this.touchLocked) {
        this.unlock()
      }

      if (input instanceof File) {
        let reader = new FileReader()

        reader.onload = () => {
          res(reader.result as ArrayBuffer)
        }

        reader.readAsArrayBuffer(input)
      } else {
        fetch(input).then(response => {
          response.arrayBuffer().then(arrayBuffer => {
            res(arrayBuffer)
          }).catch(err => {
            rej(err)
          })
        }).catch(err => {
          rej(err)
        })
      }
    })
  }

  public metadata() {
    let data = {} as Record<string, string>

    let keyNameBuffer = 0
    let keys = libopenmpt.UTF8ToString(
      libopenmpt._openmpt_module_get_metadata_keys(
        this.currentPlayingNode!.modulePtr
      )
    ).split(';')

    for (let key of keys) {
      keyNameBuffer = libopenmpt._malloc(key.length + 1)

      libopenmpt.writeAsciiToMemory(key, keyNameBuffer, false)

      data[key] = libopenmpt.UTF8ToString(
        libopenmpt._openmpt_module_get_metadata(
          this.currentPlayingNode!.modulePtr,
          keyNameBuffer
        )
      )

      libopenmpt._free(keyNameBuffer)
    }

    return data
  }

  public onEnded(handler: (...args: any[]) => void) {
    this.addHandler('onEnded', handler)
  }

  public onError(handler: (...args: any[]) => void) {
    this.addHandler('onError', handler)
  }

  public play(buffer: ArrayBuffer) {
    this.unlock()
    this.stop()

    let processNode = this.createLibopenmptNode(buffer, this.config)

    if (!processNode) {
      return
    }

    libopenmpt._openmpt_module_set_repeat_count(
      processNode.modulePtr,
      this.config.repeatCount || 0
    )

    this.currentPlayingNode = processNode

    processNode.connect(this.context)

    this.context.connect(this.audioContext.destination)
  }

  public position() {
    return libopenmpt._openmpt_module_get_position_seconds(
      this.currentPlayingNode!.modulePtr
    )
  }

  public seek(position: number) {
    if (this.currentPlayingNode) {
      libopenmpt._openmpt_module_set_position_seconds(
        this.currentPlayingNode.modulePtr,
        position
      )
    }
  }

  public stop() {
    if (this.currentPlayingNode) {
      this.currentPlayingNode.disconnect()
      this.currentPlayingNode.cleanup()

      delete this.currentPlayingNode
    }
  }

  public togglePause() {
    if (this.currentPlayingNode) {
      this.currentPlayingNode.togglePause()
    }
  }

  public unlock() {
    let context = this.audioContext

    let buffer = context.createBuffer(1, 1, 22050)
    let unlockSource = context.createBufferSource()
    unlockSource.buffer = buffer

    unlockSource.connect(this.context)

    this.context.connect(context.destination)

    unlockSource.start(0)

    this.touchLocked = false
  }

  public version() {
    if (this.currentPlayingNode && this.currentPlayingNode.modulePtr) {
      return libopenmpt._openmpt_get_library_version()
    }

    return 0
  }
}
