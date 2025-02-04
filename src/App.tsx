import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Settings, Volume2, VolumeX, Loader2, Wand2, StopCircle } from 'lucide-react';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI('AIzaSyAXsKG6WobxqU3RrXihE_k7_Dxeo5gWoJ8');
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

const cleanText = (text: string): string => {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[•\-*]\s/g, '')
    .replace(/:\s/g, '. ')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b\d+\.\s/g, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/[^\w\s.,!?-]|_/g, '')
    .trim();
};

class SpeechQueue {
  private queue: string[] = [];
  private speaking = false;
  private maxRetries = 3;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private paused = false;
  private maxChunkLength = 80;
  private minPauseDuration = 150;
  private isRelevant = true;
  private cancelRequested = false;

  async add(text: string, speakFn: (text: string) => Promise<void>) {
    if (!this.isRelevant || !text.trim() || this.cancelRequested) return;
    
    const cleanedText = cleanText(text);
    if (!cleanedText) return;
    
    const chunks = this.splitIntoChunks(cleanedText);
    this.queue.push(...chunks);
    
    if (!this.speaking && !this.paused) {
      await this.process(speakFn);
    }
  }

  private splitIntoChunks(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+/)
      .filter(sentence => sentence.trim())
      .map(sentence => {
        sentence = sentence.trim();
        return sentence.length <= this.maxChunkLength 
          ? sentence 
          : sentence.slice(0, this.maxChunkLength) + '...';
      });
  }

  private async process(speakFn: (text: string) => Promise<void>) {
    while (this.queue.length > 0 && !this.paused && this.isRelevant && !this.cancelRequested) {
      this.speaking = true;
      const text = this.queue[0];
      let success = false;
      let retries = 0;

      while (!success && retries < this.maxRetries && !this.paused && this.isRelevant && !this.cancelRequested) {
        try {
          await speakFn(text);
          success = true;
          this.queue.shift();
          await new Promise(resolve => setTimeout(resolve, this.minPauseDuration));
        } catch (err: any) {
          if (err?.name === 'NotAllowedError' || err?.message?.includes('interrupted')) {
            this.queue.shift();
            break;
          }
          retries++;
          if (retries === this.maxRetries) {
            console.error('Failed to speak after max retries:', text);
            this.queue.shift();
          }
          await new Promise(resolve => setTimeout(resolve, 300 * Math.pow(2, retries)));
        }
      }
    }
    this.speaking = false;
  }

  markIrrelevant() {
    this.isRelevant = false;
    this.clear();
  }

  markRelevant() {
    this.isRelevant = true;
    this.cancelRequested = false;
  }

  clear() {
    this.cancelRequested = true;
    this.queue = [];
    this.speaking = false;
    this.paused = false;
    if (this.currentUtterance) {
      window.speechSynthesis.cancel();
      this.currentUtterance = null;
    }
  }

  setCurrentUtterance(utterance: SpeechSynthesisUtterance) {
    if (this.cancelRequested) return;
    this.currentUtterance = utterance;
  }

  get isEmpty() {
    return this.queue.length === 0;
  }
}

function App() {
  const [isListening, setIsListening] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationContext, setConversationContext] = useState<string[]>([]);
  const [isInterrupted, setIsInterrupted] = useState(false);
  const [isActive, setIsActive] = useState(false);
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechQueueRef = useRef<SpeechQueue>(new SpeechQueue());
  const restartTimeoutRef = useRef<number | null>(null);
  const isInitializedRef = useRef(false);

  useEffect(() => {
    if (!isInitializedRef.current) {
      synthRef.current = window.speechSynthesis;
      initializeRecognition();
      isInitializedRef.current = true;
    }

    return () => cleanup();
  }, []);

  const cleanup = () => {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
    }
    if (synthRef.current?.speaking) {
      synthRef.current.cancel();
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (err) {
        console.error('Error stopping recognition:', err);
      }
    }
    speechQueueRef.current.clear();
    setIsActive(false);
    setIsListening(false);
    setIsSpeaking(false);
  };

  const stopConversation = async () => {
    // Immediately stop speech synthesis and clear queue
    if (synthRef.current?.speaking) {
      synthRef.current.cancel();
    }
    speechQueueRef.current.clear();
    setIsSpeaking(false);

    // Stop recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (err) {
        console.error('Error stopping recognition:', err);
      }
    }

    // Clear all states
    setMessage('');
    setResponse('');
    setConversationContext([]);
    setIsListening(false);
    setIsActive(false);
    setIsProcessing(false);
    setIsInterrupted(false);
    setError(null);

    // Speak goodbye message and ensure it's the last thing spoken
    try {
      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay to ensure previous speech is cancelled
      await speakText("Conversation ended.", true);
    } catch (err) {
      console.error('Error speaking goodbye message:', err);
    }
  };

  const restartRecognition = () => {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
    }
    
    restartTimeoutRef.current = window.setTimeout(() => {
      if (isListening && recognitionRef.current && isActive) {
        try {
          recognitionRef.current.start();
          console.log('Recognition restarted');
        } catch (err) {
          console.error('Failed to restart recognition:', err);
          setError('Failed to restart voice recognition. Please try again.');
          setIsListening(false);
          setIsActive(false);
        }
      }
    }, 100);
  };

  const handleInterruption = async (interruptionText: string) => {
    setIsInterrupted(true);
    speechQueueRef.current.clear();
    if (synthRef.current?.speaking) {
      synthRef.current.cancel();
      setIsSpeaking(false);
    }

    await speakText("I understand, let me address that.", true);
    await processMessage(interruptionText, true);
    setIsInterrupted(false);
  };

  const toggleListening = () => {
    try {
      if (isListening) {
        if (recognitionRef.current) {
          recognitionRef.current.stop();
          setIsListening(false);
          setIsActive(false);
          console.log('Recognition stopped');
        }
      } else {
        setMessage('');
        setError(null);
        if (recognitionRef.current) {
          recognitionRef.current.start();
          setIsListening(true);
          setIsActive(true);
          console.log('Recognition started');
        } else {
          initializeRecognition();
          setTimeout(() => {
            if (recognitionRef.current) {
              recognitionRef.current.start();
              setIsListening(true);
              setIsActive(true);
              console.log('Recognition initialized and started');
            }
          }, 100);
        }
      }
    } catch (err) {
      console.error('Error toggling listening:', err);
      setError('Failed to toggle voice recognition. Please try again.');
      setIsListening(false);
      setIsActive(false);
    }
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (synthRef.current?.speaking) {
      synthRef.current.cancel();
      setIsSpeaking(false);
    }
    speechQueueRef.current.clear();
  };

  const speakText = async (text: string, isInterruption: boolean = false): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!isMuted && synthRef.current && text.trim()) {
        try {
          if (synthRef.current.speaking) {
            synthRef.current.cancel();
          }

          const utterance = new SpeechSynthesisUtterance(text);
          
          // Set up event handlers before speaking
          utterance.onstart = () => {
            setIsSpeaking(true);
          };
          
          utterance.onend = () => {
            setIsSpeaking(false);
            speechQueueRef.current.setCurrentUtterance(null);
            resolve();
          };

          utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event);
            setIsSpeaking(false);
            speechQueueRef.current.setCurrentUtterance(null);
            
            if (event.error === 'interrupted' || event.error === 'canceled') {
              resolve();
            } else {
              reject(new Error(`Speech synthesis failed: ${event.error}`));
            }
          };

          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          utterance.volume = 1.0;

          const voices = synthRef.current.getVoices();
          const preferredVoice = voices.find(voice => 
            voice.name.toLowerCase().includes('female') || 
            voice.name.toLowerCase().includes('samantha') ||
            voice.name.toLowerCase().includes('google')
          );
          
          if (preferredVoice) {
            utterance.voice = preferredVoice;
          }

          speechQueueRef.current.setCurrentUtterance(utterance);
          synthRef.current.speak(utterance);
        } catch (err) {
          console.error('Speech synthesis setup error:', err);
          reject(err);
        }
      } else {
        resolve();
      }
    });
  };

  const processMessage = async (text: string, isInterruption: boolean = false) => {
    try {
      setIsProcessing(true);
      setError(null);

      // Check for stop commands
      const stopCommands = ['stop', 'end', 'quit', 'exit', 'bye', 'goodbye'];
      if (stopCommands.some(cmd => text.toLowerCase().includes(cmd))) {
        stopConversation();
        return;
      }

      const cleanedText = text.trim();
      if (!cleanedText) {
        setError('Please provide some input to process.');
        return;
      }

      // Mark previous responses as irrelevant if this is a new topic
      if (!isInterruption) {
        speechQueueRef.current.markIrrelevant();
      }

      const context = isInterruption 
        ? "Provide a very brief response to: " + cleanedText
        : "Provide a concise response to: " + cleanedText;

      const result = await model.generateContent([
        ...conversationContext.slice(-2), // Keep context minimal for conciseness
        context
      ]);
      
      if (!result || !result.response) {
        throw new Error('Failed to generate response');
      }

      const response = await result.response;
      const responseText = response.text();
      
      if (!responseText.trim()) {
        throw new Error('Received empty response');
      }

      speechQueueRef.current.markRelevant();
      
      if (!isInterruption) {
        setConversationContext(prev => [...prev.slice(-2), cleanedText, responseText]);
      }
      
      setResponse(responseText);

      const sentences = responseText
        .split(/(?<=[.!?])\s+/)
        .filter(sentence => sentence.trim())
        .map(sentence => cleanText(sentence));

      for (const sentence of sentences) {
        if (sentence) {
          await speechQueueRef.current.add(sentence, speakText);
        }
      }
    } catch (err) {
      console.error('Error processing message:', err);
      setError(err instanceof Error ? err.message : 'Failed to process your request. Please try again.');
      cleanup();
    } finally {
      setIsProcessing(false);
    }
  };

  const initializeRecognition = () => {
    if (!('webkitSpeechRecognition' in window)) {
      setError('Speech recognition is not supported in your browser.');
      return;
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setError(null);
      setIsListening(true);
      setIsActive(true);
      console.log('Speech recognition started');
    };

    recognition.onresult = (event: any) => {
      const lastResult = event.results[event.results.length - 1];
      const transcript = lastResult[0].transcript;
      
      setMessage(transcript);
      
      if (lastResult.isFinal) {
        if (isSpeaking && !isInterrupted) {
          handleInterruption(transcript);
        } else if (!isSpeaking) {
          processMessage(transcript);
        }
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      if (event.error !== 'no-speech') {
        setError(`Recognition error: ${event.error}`);
      }
      restartRecognition();
    };

    recognition.onend = () => {
      console.log('Speech recognition ended');
      if (isListening && !isActive) {
        restartRecognition();
      }
    };

    recognitionRef.current = recognition;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900 flex items-center justify-center p-4">
      <div className="bg-white/10 backdrop-blur-lg rounded-2xl w-full max-w-2xl p-8 shadow-2xl border border-white/20">
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <Wand2 className="w-8 h-8 text-white" />
            <h1 className="text-3xl font-bold text-white">Voice Assistant</h1>
          </div>
          <div className="flex gap-4">
            <button
              onClick={toggleMute}
              className={`p-3 rounded-full transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-white/50 ${
                isMuted ? 'bg-red-500/20' : 'bg-white/20 hover:bg-white/30'
              }`}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? (
                <VolumeX className="w-6 h-6 text-white" />
              ) : (
                <Volume2 className="w-6 h-6 text-white" />
              )}
            </button>
            <button 
              className="p-3 rounded-full bg-white/20 hover:bg-white/30 transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-white/50"
              title="Settings"
            >
              <Settings className="w-6 h-6 text-white" />
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <div className="relative">
            <div 
              className={`absolute inset-0 bg-white/5 rounded-xl transition-all duration-500 ${
                isListening ? 'scale-105 bg-white/10 shadow-lg' : 'scale-100'
              }`} 
            />
            <div className="relative p-6 rounded-xl border border-white/20">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-white/80">Message:</p>
                {isListening && (
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-[pulse_1s_ease-in-out_infinite]" />
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-[pulse_1s_ease-in-out_infinite_0.2s]" />
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-[pulse_1s_ease-in-out_infinite_0.4s]" />
                  </div>
                )}
              </div>
              <p className="text-white min-h-[2rem] transition-all duration-300">
                {message || 'Waiting for voice input...'}
              </p>
            </div>
          </div>

          <div className="flex justify-center gap-4">
            <button
              onClick={toggleListening}
              disabled={isProcessing}
              className={`p-6 rounded-full transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-white/50 ${
                isListening
                  ? 'bg-red-500 hover:bg-red-600'
                  : 'bg-indigo-500 hover:bg-indigo-600'
              } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''} ${
                isListening ? 'animate-[pulse_2s_ease-in-out_infinite]' : ''
              }`}
            >
              {isListening ? (
                <MicOff className="w-8 h-8 text-white" />
              ) : (
                <Mic className="w-8 h-8 text-white" />
              )}
            </button>

            {isActive && (
              <button
                onClick={stopConversation}
                className="p-6 rounded-full bg-red-500 hover:bg-red-600 transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-white/50"
                title="Stop Conversation"
              >
                <StopCircle className="w-8 h-8 text-white" />
              </button>
            )}
          </div>

          <div className="relative">
            <div 
              className={`absolute inset-0 bg-white/5 rounded-xl transition-all duration-500 ${
                isProcessing || isSpeaking ? 'scale-105 bg-white/10 shadow-lg' : 'scale-100'
              }`} 
            />
            <div className="relative p-6 rounded-xl border border-white/20">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-white/80">Response:</p>
                {isProcessing && (
                  <Loader2 className="w-4 h-4 text-white animate-spin" />
                )}
                {isSpeaking && (
                  <div className="flex gap-1">
                    <div className="w-1 h-4 bg-indigo-500 rounded-full animate-[pulse_1s_ease-in-out_infinite]" />
                    <div className="w-1 h-4 bg-indigo-500 rounded-full animate-[pulse_1s_ease-in-out_infinite_0.2s]" />
                    <div className="w-1 h-4 bg-indigo-500 rounded-full animate-[pulse_1s_ease-in-out_infinite_0.4s]" />
                  </div>
                )}
              </div>
              <p className="text-white min-h-[2rem] transition-all duration-300">
                {response || 'No response yet'}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-4 bg-red-500/20 border border-red-500/40 rounded-lg">
            <p className="text-white text-sm">{error}</p>
          </div>
        )}

        <div className="mt-8 text-center">
          <p className="text-white/60 text-sm">
            {isListening ? 'Listening...' : 'Click the microphone and speak clearly'}
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;