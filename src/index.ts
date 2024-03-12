import type { MainModule } from './libopenmpt.js'

export interface IProcessNode extends ScriptProcessorNode {
  cleanup(): void
  config: ChiptuneJsConfig
  leftBufferPtr: number
  modulePtr: number
  pause(): void
  paused: boolean
  player: ChiptuneJsPlayer
  rightBufferPtr: number
  stop(): void
  togglePause(): void
  unpause(): void
}

const libopenmpt = (await import('./libopenmpt.js')).default as MainModule

const OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH = 3
const OPENMPT_MODULE_RENDER_STEREOSEPARATION_PERCENT = 2

export class ChiptuneAudioContext extends AudioContext {}

export class ChiptuneJsConfig {
  public context?: ChiptuneAudioContext
  public interpolationFilter: number
  public repeatCount: number
  public stereoSeparation: number

  constructor(
    repeatCount: number,
    stereoSeparation: number,
    interpolationFilter: number,
    context?: ChiptuneAudioContext
  ) {
    this.context = context
    this.interpolationFilter = interpolationFilter
    this.repeatCount = repeatCount
    this.stereoSeparation = stereoSeparation
  }
}

export class ChiptuneJsPlayer {
  public config: ChiptuneJsConfig
  public context: ChiptuneAudioContext
  public currentPlayingNode?: IProcessNode
  public handlers: { eventName: string; handler: (...args: any[]) => void }[]
  public touchLocked: boolean

  constructor(config: ChiptuneJsConfig) {
    this.config = config
    this.context = config.context || new ChiptuneAudioContext()
    this.handlers = []
    this.touchLocked = true
  }

  public addHandler(eventName: string, handler: (...args: any[]) => void) {
    this.handlers.push({ eventName, handler })
  }

  public createLibopenmptNode(buffer: Buffer, config: ChiptuneJsConfig) {
    let maxFramesPerChunk = 4096
    let processNode = this.context.createScriptProcessor(
      2048,
      0,
      2
    ) as IProcessNode

    processNode.config = config
    processNode.player = this

    let byteArray = new Int8Array(buffer)
    let ptrToFile = libopenmpt._malloc(byteArray.byteLength)

    libopenmpt.HEAPU8.set(byteArray, ptrToFile)

    processNode.modulePtr = libopenmpt._openmpt_module_create_from_memory(
      ptrToFile,
      byteArray.byteLength,
      0,
      0,
      0
    )

    processNode.paused = false

    processNode.leftBufferPtr = libopenmpt._malloc(maxFramesPerChunk * 4)
    processNode.rightBufferPtr = libopenmpt._malloc(maxFramesPerChunk * 4)

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

    processNode.stop = function() {
      this.disconnect()
      this.cleanup()
    }

    processNode.pause = function() {
      this.paused = true
    }

    processNode.unpause = function() {
      this.paused = false
    }

    processNode.togglePause = function() {
      this.paused = !this.paused
    }

    processNode.onaudioprocess = function(
      this: IProcessNode,
      ev: AudioProcessingEvent
    ) {
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
    } as any

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

  public getCurrentOrder() {
    return libopenmpt._openmpt_module_get_current_order(
      this.currentPlayingNode!.modulePtr
    )
  }

  public getCurrentPattern() {
    return libopenmpt._openmpt_module_get_current_pattern(
      this.currentPlayingNode!.modulePtr
    )
  }

  public getCurrentRow() {
    return libopenmpt._openmpt_module_get_current_row(
      this.currentPlayingNode!.modulePtr
    )
  }

  public getCurrentTime() {
    return libopenmpt._openmpt_module_get_position_seconds(
      this.currentPlayingNode!.modulePtr
    )
  }

  public getTotalOrder() {
    return libopenmpt._openmpt_module_get_num_orders(
      this.currentPlayingNode!.modulePtr
    )
  }

  public getTotalPatterns() {
    return libopenmpt._openmpt_module_get_num_patterns(
      this.currentPlayingNode!.modulePtr
    )
  }

  public load(input: File | string, callback: (...args: any[]) => void) {
    if (this.touchLocked) {
      this.unlock()
    }

    let player = this

    if (input instanceof File) {
      let reader = new FileReader()

      reader.onload = function() {
        return callback(reader.result)
      }.bind(this)

      reader.readAsArrayBuffer(input)
    } else {
      let xhr = new XMLHttpRequest()

      xhr.open('GET', input, true)

      xhr.onabort = () => {
        this.fireEvent('onError', { type: 'onxhr' })
      }

      xhr.onerror = () => {
        this.fireEvent('onError', { type: 'onxhr' })
      }

      xhr.onload = function() {
        if (xhr.status === 200) {
          return callback(xhr.response)
        }

        player.fireEvent('onError', { type: 'onxhr' })
      }.bind(this)

      xhr.responseType = 'arraybuffer'

      xhr.send()
    }
  }

  public metadata() {
    let data = {} as Record<string, string>

    let keyNameBuffer = 0
    let keys = libopenmpt.UTF8ToString(
      libopenmpt._openmpt_module_get_metadata_keys(
        this.currentPlayingNode!.modulePtr
      )
    ).split(';')

    for (let i = 0; i < keys.length; i++) {
      keyNameBuffer = libopenmpt._malloc(keys[i]!.length + 1)

      libopenmpt.writeAsciiToMemory(keys[i]!, keyNameBuffer, false)

      data[keys[i]!] = libopenmpt.UTF8ToString(
        libopenmpt._openmpt_module_get_metadata(
          this.currentPlayingNode!.modulePtr,
          keyNameBuffer
        )
      )

      libopenmpt._free(keyNameBuffer)
    }

    return data
  }

  public moduleCtlSet(ctl: string, value: string) {
    return libopenmpt.ccall(
      'openmpt_module_ctl_set',
      'number',
      ['number', 'string', 'string'],
      [
        this.currentPlayingNode!.modulePtr,
        ctl,
        value
      ]
    ) === 1
  }

  public onEnded(handler: (...args: any[]) => void) {
    this.addHandler('onEnded', handler)
  }

  public onError(handler: (...args: any[]) => void) {
    this.addHandler('onError', handler)
  }

  public play(buffer: Buffer) {
    this.stop()

    let processNode = this.createLibopenmptNode(buffer, this.config)

    if (!processNode) {
      return
    }

    libopenmpt._openmpt_module_set_repeat_count(
      processNode.modulePtr,
      this.config.repeatCount
    )

    libopenmpt._openmpt_module_set_render_param(
      processNode.modulePtr,
      OPENMPT_MODULE_RENDER_STEREOSEPARATION_PERCENT,
      this.config.stereoSeparation
    )

    libopenmpt._openmpt_module_set_render_param(
      processNode.modulePtr,
      OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH,
      this.config.interpolationFilter
    )

    this.currentPlayingNode = processNode

    processNode.connect(this.context.destination)
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
    let context = this.context

    let buffer = context.createBuffer(1, 1, 22050)
    let unlockSource = context.createBufferSource()
    unlockSource.buffer = buffer

    unlockSource.connect(context.destination)
    unlockSource.start(0)

    this.touchLocked = false
  }
}
