// word-extractor (legacy .doc reader) ships no types.
declare module 'word-extractor' {
  class WordExtractor {
    extract(input: Buffer | string): Promise<{ getBody(): string }>;
  }
  export default WordExtractor;
}
