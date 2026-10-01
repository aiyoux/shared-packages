import { CLIPTokenizer } from '@huggingface/transformers';
import { ImageGenError } from './engines.js';

const BOS = '<|startoftext|>';
const EOS = '<|endoftext|>';

/** Build CLIP's byte-level BPE tokenizer from the SD bundles' stored files.
 * These repos ship vocab/merges, not the tokenizer.json AutoTokenizer needs.
 * Constructing it directly also keeps model loading entirely offline.
 */
export function createSdTokenizer(files: Map<string, ArrayBuffer>): CLIPTokenizer {
	const decoder = new TextDecoder();
	function text(path: string): string {
		const buffer = files.get(path);
		if (!buffer) throw new ImageGenError('NO_MODEL', `Model files are missing ${path}`);
		return decoder.decode(buffer);
	}
	const vocab = JSON.parse(text('tokenizer/vocab.json')) as Record<string, number>;
	const merges = text('tokenizer/merges.txt')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'));
	if (vocab[BOS] == null || vocab[EOS] == null) {
		throw new ImageGenError('NO_MODEL', 'CLIP vocabulary is missing its start/end tokens');
	}
	const tokenizer = new CLIPTokenizer(
		{
			added_tokens: [BOS, EOS].map((content) => ({
				id: vocab[content], content, special: true,
				single_word: false, lstrip: false, rstrip: false, normalized: true
			})),
			normalizer: {
				type: 'Sequence',
				normalizers: [
					{ type: 'NFC' },
					{ type: 'Replace', pattern: { Regex: '\\s+' }, content: ' ' },
					{ type: 'Lowercase' }
				]
			},
			pre_tokenizer: {
				type: 'Sequence',
				pretokenizers: [
					{
						type: 'Split',
						pattern: { Regex: "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+" },
						behavior: 'Removed', invert: true
					},
					{ type: 'ByteLevel', add_prefix_space: false, trim_offsets: true, use_regex: true }
				]
			},
			post_processor: {
				type: 'RobertaProcessing',
				cls: [BOS, vocab[BOS]], sep: [EOS, vocab[EOS]],
				trim_offsets: false, add_prefix_space: false
			},
			decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: true, use_regex: true },
			model: {
				type: 'BPE', vocab, merges, unk_token: EOS,
				end_of_word_suffix: '</w>', continuing_subword_prefix: '',
				fuse_unk: false, byte_fallback: false
			}
		},
		{ bos_token: BOS, eos_token: EOS, unk_token: EOS, pad_token: '!', model_max_length: 77 }
	);
	// Both exported SD text encoders use zero padding in their browser recipe.
	tokenizer.pad_token_id = 0;
	return tokenizer;
}

/** The exported text encoders and UNet attention require exactly 77 tokens. */
export function encodeSdPrompt(tokenizer: CLIPTokenizer, prompt: string): number[] {
	return tokenizer(prompt, {
		padding: 'max_length', max_length: 77, truncation: true, return_tensor: false
	}).input_ids as number[];
}
