--!strict
-- Incremental SHA-256 over raw bytes, per FIPS 180-4. A digest grants no upload/engine authority.
-- Synchronous, dependency-free, with private state and fewer than 64 pending bytes.

local MAX_UPDATE_BYTES = 512 * 1024
local MAX_TOTAL_BYTES = 32 * 1024 * 1024
local WORD_MASK = 0xffffffff
local ROUND_CONSTANTS: {number} = table.freeze({
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
})

local band, bxor, bnot = bit32.band, bit32.bxor, bit32.bnot
local lshift, rshift, rrotate = bit32.lshift, bit32.rshift, bit32.rrotate

local function compress(state: {number}, words: {number}, bytes: string, offset: number): ()
	for index = 1, 16 do
		local first = offset + (index - 1) * 4
		local a, b, c, d = string.byte(bytes, first, first + 3)
		words[index] = lshift(a, 24) + lshift(b, 16) + lshift(c, 8) + d
	end
	for index = 17, 64 do
		local previous15, previous2 = words[index - 15], words[index - 2]
		local sigma0 = bxor(rrotate(previous15, 7), rrotate(previous15, 18), rshift(previous15, 3))
		local sigma1 = bxor(rrotate(previous2, 17), rrotate(previous2, 19), rshift(previous2, 10))
		words[index] = band(words[index - 16] + sigma0 + words[index - 7] + sigma1, WORD_MASK)
	end

	local a, b, c, d, e, f, g, h = state[1], state[2], state[3], state[4], state[5], state[6], state[7], state[8]
	for index = 1, 64 do
		local sigma1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
		local choose = bxor(band(e, f), band(bnot(e), g))
		local temporary1 = band(h + sigma1 + choose + ROUND_CONSTANTS[index] + words[index], WORD_MASK)
		local sigma0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
		local majority = bxor(band(a, b), band(a, c), band(b, c))
		local temporary2 = band(sigma0 + majority, WORD_MASK)
		h = g
		g = f
		f = e
		e = band(d + temporary1, WORD_MASK)
		d = c
		c = b
		b = a
		a = band(temporary1 + temporary2, WORD_MASK)
	end
	state[1] = band(state[1] + a, WORD_MASK)
	state[2] = band(state[2] + b, WORD_MASK)
	state[3] = band(state[3] + c, WORD_MASK)
	state[4] = band(state[4] + d, WORD_MASK)
	state[5] = band(state[5] + e, WORD_MASK)
	state[6] = band(state[6] + f, WORD_MASK)
	state[7] = band(state[7] + g, WORD_MASK)
	state[8] = band(state[8] + h, WORD_MASK)
end

export type Hasher = {
	update: (self: Hasher, bytes: string) -> (),
	digest: (self: Hasher) -> string,
}

local function new(): Hasher
	local state = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19}
	local words: {number} = table.create(64, 0)
	local tail = ""
	local totalBytes = 0
	local finalizedDigest: string? = nil
	local hasher: Hasher

	local function update(self: Hasher, bytes: string): ()
		if self ~= hasher then
			error("SHA-256 stream method requires its original hasher.", 2)
		end
		if finalizedDigest ~= nil then
			error("SHA-256 stream is finalized; updates are forbidden.", 2)
		end
		if type(bytes) ~= "string" then
			error("SHA-256 stream input must be a string.", 2)
		end
		local length = #bytes
		if length > MAX_UPDATE_BYTES then
			error("SHA-256 stream update exceeds the 524288-byte limit.", 2)
		end
		if totalBytes + length > MAX_TOTAL_BYTES then
			error("SHA-256 stream exceeds the 33554432-byte cumulative limit.", 2)
		end

		-- Validation precedes all mutation; a rejected update leaves the stream usable.
		totalBytes += length
		local offset = 1
		if #tail > 0 then
			local needed = 64 - #tail
			if length < needed then
				tail ..= bytes
				return
			end
			compress(state, words, tail .. string.sub(bytes, 1, needed), 1)
			tail = ""
			offset = needed + 1
		end
		local fullEnd = length - (length - offset + 1) % 64
		for blockOffset = offset, fullEnd, 64 do
			compress(state, words, bytes, blockOffset)
		end
		tail = string.sub(bytes, fullEnd + 1)
	end

	local function digest(self: Hasher): string
		if self ~= hasher then
			error("SHA-256 stream method requires its original hasher.", 2)
		end
		-- Finalize once; repeated digest calls return the identical cached hex string.
		if finalizedDigest ~= nil then
			return finalizedDigest
		end
		-- FIPS 180-4: 0x80, zeros, then the original 64-bit big-endian bit length.
		-- At most 32 MiB means <= 2^28 bits: the high word is zero, the low word exact.
		local bitLength = totalBytes * 8
		local padding = tail .. "\128" .. string.rep("\0", (55 - totalBytes) % 64)
			.. string.char(0, 0, 0, 0, rshift(bitLength, 24), band(rshift(bitLength, 16), 0xff), band(rshift(bitLength, 8), 0xff), band(bitLength, 0xff))
		for offset = 1, #padding, 64 do
			compress(state, words, padding, offset)
		end
		local result = string.format("%08x%08x%08x%08x%08x%08x%08x%08x", state[1], state[2], state[3], state[4], state[5], state[6], state[7], state[8])
		finalizedDigest = result
		tail = ""
		table.clear(state)
		table.clear(words)
		return result
	end

	hasher = table.freeze({update = update, digest = digest})
	return hasher
end

return table.freeze({new = new})
