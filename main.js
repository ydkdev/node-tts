import * as difflib from "difflib"
import "dotenv/config"
import express from "express"
import _ from "lodash"
import * as sdk from "microsoft-cognitiveservices-speech-sdk"
import {
  AudioConfig,
  AudioInputStream,
  AudioStreamFormat,
  PronunciationAssessmentConfig,
  PronunciationAssessmentGradingSystem,
  PronunciationAssessmentGranularity,
  PronunciationAssessmentResult,
  ResultReason,
  SpeechConfig,
  SpeechRecognizer,
} from "microsoft-cognitiveservices-speech-sdk"
import pino from "pino"
import pinoHttp from "pino-http"

const app = express()
const port = 8081

const logger = pino({ level: process.env.LOG_LEVEL || "info" })
const httpLogger = pinoHttp({ logger })

app.use(httpLogger) // 作为中间件使用

// --- Azure Speech Configuration ---
// 务必使用环境变量来存储敏感信息，这里为了演示直接写入
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION
const language = process.env.LANGUAGE

if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
  throw new Error("AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is not set.")
}

const speechConfig = SpeechConfig.fromSubscription(
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION
)
speechConfig.speechRecognitionLanguage = language

// 接口: /pronunciationAssessment
app.post("/pronunciationAssessment", async (req, res) => {
  // 将回调设为 async
  let referenceText = req.headers["x-reference-text"]
  if (!referenceText) {
    return res
      .status(400)
      .json({ error: "X-Reference-Text header is required." })
  }

  if (Array.isArray(referenceText)) {
    referenceText = referenceText[0]
  }

  let rawAudioDuration = req.headers["x-audio-duration"] // seconds

  if (Array.isArray(rawAudioDuration)) {
    rawAudioDuration = rawAudioDuration[0]
  }

  const audioDuration = Number(rawAudioDuration) || 0

  const isShortAudio = audioDuration <= 30

  // --- SDK 对象初始化 ---
  const pushStream = AudioInputStream.createPushStream(
    AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
  )

  const audioConfig = AudioConfig.fromStreamInput(pushStream)
  const reco = new SpeechRecognizer(speechConfig, audioConfig)

  // try...finally 确保 reco.close() 总是被调用
  try {
    // --- 配置发音评估 ---
    const pronunciationAssessmentConfig = new PronunciationAssessmentConfig(
      referenceText,
      PronunciationAssessmentGradingSystem.HundredMark,
      PronunciationAssessmentGranularity.Phoneme,
      false
    )
    pronunciationAssessmentConfig.enableProsodyAssessment = true

    pronunciationAssessmentConfig.phonemeAlphabet = "IPA"
    pronunciationAssessmentConfig.nbestPhonemeCount = 1

    pronunciationAssessmentConfig.applyTo(reco)

    // --- 创建一个 Promise 来包装识别过程 ---
    const recognitionPromise = new Promise((resolve, reject) => {
      // 将识别结果的处理逻辑移入 Promise
      if (isShortAudio) {
        reco.recognizeOnceAsync(
          (successfulResult) => {
            resolve(successfulResult)
          },
          (error) => {
            reject(error)
          }
        )
      } else {
        continueRecognize(reco, referenceText, resolve, reject)
      }

      req.on("data", (chunk) => {
        pushStream.write(chunk)
      })

      req.on("end", () => {
        pushStream.close() // 关键步骤
      })

      req.on("error", (err) => {
        logger.error(err, "请求流发生错误")
        // 如果请求流出错，也应该终止识别
        reject(new Error("Request stream error: " + err.message))
      })
    })

    // 等待识别 Promise 完成
    const result = await recognitionPromise

    // 根据识别结果发送响应
    if (isShortAudio) {
      if (result.reason === ResultReason.RecognizedSpeech) {
        const finalResult = PronunciationAssessmentResult.fromResult(result)
        res.status(200).json({
          code: 200,
          message: "Success",
          data: {
            Scores: finalResult.detailResult.PronunciationAssessment,
            Words: finalResult.detailResult.Words,
          },
        })
      } else if (result.reason === ResultReason.NoMatch) {
        res.status(500).json({
          code: 500,
          message: "NoMatch",
        })
      } else {
        // 其他原因，例如 Canceled
        res.status(500).json({
          code: 500,
          message: `Recognition failed with reason: ${result.reason}`,
        })
      }
    } else {
      if (result?.Words?.length > 1) {
        res.status(200).json({ code: 200, message: "Success", data: result })
      } else {
        res.status(500).json({
          code: 500,
          message: `Recognition failed with reason code: ${result.Error}`,
        })
      }
    }
  } catch (error) {
    logger.error(error, "处理发音评估时发生错误")
    res
      .status(500)
      .json({ code: 500, message: "An error occurred during recognition." })
  } finally {
    // --- 资源清理 ---
    reco.close()
  }
})

app.listen(port, () => {
  console.log(`Node.js assessment service listening on port ${port}`)
})

// pronunciation assessment with audio streaming and continue mode
/**
 *
 * @param {sdk.SpeechRecognizer} reco
 * @param {string} referenceText
 * @param {(v: any) => void} resolve
 * @param {(v: any) => void} reject
 *
 */
function continueRecognize(reco, referenceText, resolve, reject) {
  const scoreNumber = {
    accuracyScore: 0,
    fluencyScore: 0,
    compScore: 0,
    prosodyScore: 0,
  }
  const allWords = []
  var currentText = []
  var startOffset = 0
  var recognizedWords = []
  var fluencyScores = []
  var prosodyScores = []
  var durations = []
  var jo = {}

  // Before beginning speech recognition, setup the callbacks to be invoked when an event occurs.

  // The event recognizing signals that an intermediate recognition result is received.
  // You will receive one or more recognizing events as a speech phrase is recognized, with each containing
  // more recognized speech. The event will contain the text for the recognition since the last phrase was recognized.
  // reco.recognizing = function (s, e) {
  //   var str =
  //     "(recognizing) Reason: " +
  //     sdk.ResultReason[e.result.reason] +
  //     " Text: " +
  //     e.result.text
  //   console.log(str)
  // }

  // The event recognized signals that a final recognition result is received.
  // This is the final event that a phrase has been recognized.
  // For continuous recognition, you will get one recognized event for each phrase recognized.

  let recoginzedError

  reco.recognized = function (s, e) {
    if (e.result.reason != sdk.ResultReason.RecognizedSpeech) {
      recoginzedError = sdk.ResultReason.RecognizedSpeech
    }

    jo = JSON.parse(
      e.result.properties.getProperty(
        sdk.PropertyId.SpeechServiceResponse_JsonResult
      )
    )
    const nb = jo["NBest"][0]
    startOffset = nb.Words[0].Offset
    const localtext = _.map(nb.Words, (item) => item.Word.toLowerCase())
    currentText = currentText.concat(localtext)
    fluencyScores.push(nb.PronunciationAssessment.FluencyScore)
    prosodyScores.push(nb.PronunciationAssessment.ProsodyScore)
    const isSucceeded = jo.RecognitionStatus === "Success"
    const nBestWords = jo.NBest[0].Words
    const durationList = []
    _.forEach(nBestWords, (word) => {
      recognizedWords.push(word)
      durationList.push(word.Duration)
    })
    durations.push(_.sum(durationList))

    if (isSucceeded && nBestWords) {
      allWords.push(...nBestWords)
    }
  }

  function calculateOverallPronunciationScore() {
    const resText = currentText.join(" ")
    let wholelyricsArry = []
    let resTextArray = []

    let resTextProcessed = (resText.toLocaleLowerCase() ?? "")
      .replace(new RegExp('[!"#$%&()*+,-./:;<=>?@[^_`{|}~]+', "g"), "")
      .replace(new RegExp("]+", "g"), "")
    let wholelyrics = (referenceText.toLocaleLowerCase() ?? "")
      .replace(new RegExp('[!"#$%&()*+,-./:;<=>?@[^_`{|}~]+', "g"), "")
      .replace(new RegExp("]+", "g"), "")
    wholelyricsArry = wholelyrics.split(" ")
    resTextArray = resTextProcessed.split(" ")
    const wholelyricsArryRes = _.map(
      _.filter(wholelyricsArry, (item) => !!item),
      (item) => item.trim()
    )

    // For continuous pronunciation assessment mode, the service won't return the words with `Insertion` or `Omission`
    // We need to compare with the reference text after received all recognized words to get these error words.
    const diff = new difflib.SequenceMatcher(
      null,
      wholelyricsArryRes,
      resTextArray
    )
    const lastWords = []
    for (const d of diff.getOpcodes()) {
      if (d[0] == "insert" || d[0] == "replace") {
        for (let j = d[3]; j < d[4]; j++) {
          if (
            allWords &&
            allWords.length > 0 &&
            allWords[j].PronunciationAssessment.ErrorType !== "Insertion"
          ) {
            allWords[j].PronunciationAssessment.ErrorType = "Insertion"
          }
          lastWords.push(allWords[j])
        }
      }
      if (d[0] == "delete" || d[0] == "replace") {
        if (
          d[2] == wholelyricsArryRes.length &&
          !(
            jo.RecognitionStatus == "Success" ||
            jo.RecognitionStatus == "Failed"
          )
        )
          continue
        for (let i = d[1]; i < d[2]; i++) {
          const word = {
            Word: wholelyricsArryRes[i],
            PronunciationAssessment: {
              ErrorType: "Omission",
            },
          }
          lastWords.push(word)
        }
      }
      if (d[0] == "equal") {
        for (let k = d[3], count = 0; k < d[4]; count++) {
          lastWords.push(allWords[k])
          k++
        }
      }
    }

    let reference_words = []
    reference_words = wholelyricsArryRes

    let recognizedWordsRes = []
    _.forEach(recognizedWords, (word) => {
      if (word.PronunciationAssessment.ErrorType == "None") {
        recognizedWordsRes.push(word)
      }
    })

    let compScore = Number(
      ((recognizedWordsRes.length / reference_words.length) * 100).toFixed(0)
    )
    if (compScore > 100) {
      compScore = 100
    }
    scoreNumber.compScore = compScore

    const accuracyScores = []
    _.forEach(lastWords, (word) => {
      if (word && word?.PronunciationAssessment?.ErrorType != "Insertion") {
        accuracyScores.push(
          Number(word?.PronunciationAssessment.AccuracyScore ?? 0)
        )
      }
    })
    scoreNumber.accuracyScore = Number(
      (_.sum(accuracyScores) / accuracyScores.length).toFixed(0)
    )

    if (startOffset) {
      const sumRes = []
      _.forEach(fluencyScores, (x, index) => {
        sumRes.push(x * durations[index])
      })
      scoreNumber.fluencyScore = _.sum(sumRes) / _.sum(durations)
    }

    scoreNumber.prosodyScore = _.sum(prosodyScores) / prosodyScores.length

    const sortScore = Object.keys(scoreNumber).sort(function (a, b) {
      return scoreNumber[a] - scoreNumber[b]
    })
    if (jo.RecognitionStatus == "Success" || jo.RecognitionStatus == "Failed") {
      scoreNumber.pronScore = Number(
        (
          scoreNumber[sortScore["0"]] * 0.4 +
          scoreNumber[sortScore["1"]] * 0.2 +
          scoreNumber[sortScore["2"]] * 0.2 +
          scoreNumber[sortScore["3"]] * 0.2
        ).toFixed(0)
      )
    } else {
      scoreNumber.pronScore = Number(
        (
          scoreNumber.accuracyScore * 0.6 +
          scoreNumber.fluencyScore * 0.2 +
          scoreNumber.prosodyScore * 0.2
        ).toFixed(0)
      )
    }
  }

  // The event signals that the service has stopped processing speech.
  // https://docs.microsoft.com/javascript/api/microsoft-cognitiveservices-speech-sdk/speechrecognitioncanceledeventargs?view=azure-node-latest
  // This can happen for two broad classes of reasons.
  // 1. An error is encountered.
  //    In this case the .errorDetails property will contain a textual representation of the error.
  // 2. Speech was detected to have ended.
  //    This can be caused by the end of the specified file being reached, or ~20 seconds of silence from a microphone input.
  reco.canceled = function (s, e) {
    if (e.reason === sdk.CancellationReason.Error) {
      reject("Canceled")
    }
    reco.stopContinuousRecognitionAsync()
  }

  // Signals that a new session has started with the speech service
  // reco.sessionStarted = function (s, e) {};

  // Signals the end of a session with the speech service.
  reco.sessionStopped = function () {
    reco.stopContinuousRecognitionAsync()
    calculateOverallPronunciationScore()

    resolve({
      Scores: {
        AccuracyScore: scoreNumber.accuracyScore,
        CompletenessScore: scoreNumber.compScore,
        FluencyScore: scoreNumber.fluencyScore,
        PronScore: scoreNumber.pronScore,
        ProsodyScore: scoreNumber.prosodyScore,
      },
      Words: allWords,
      Error: recoginzedError,
    })
  }

  reco.startContinuousRecognitionAsync()
}
