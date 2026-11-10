// checkpoints.ts: mainnet block hashes this build knows on its own.
//
// Ported from ONOSENDAI src/lib/hyperspace/checkpoints.ts at commit 18eded9
// (branch v2): verbatim. The 971,999 entry matches ONOSENDAI#467 and
// hosaka-core#8, added the same day.
/** The mainnet genesis block. */
export const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
export const EMBEDDED_CHECKPOINTS = [
    { height: 0, blockHash: GENESIS_HASH },
    // The final block of each published headers-v1 blob, pinned 2026-08-24;
    // every value independently confirmed against blockstream.info before
    // pinning, so the manifest host and this list are separate authorities.
    { height: 49999, blockHash: '000000000845517b31c6820d83f25cff46429bf136a7515fe504116427e60f8e' },
    { height: 99999, blockHash: '000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250' },
    { height: 149999, blockHash: '00000000000008df4269884f1d3bfc2aed3ea747292abb89be3dc3faa8c5d26f' },
    { height: 199999, blockHash: '00000000000003a20def7a05a77361b9657ff954b2f2080e135ea6f5970da215' },
    { height: 249999, blockHash: '0000000000000009c2e82d884ec07b4aafb64ca3ef83baca2b6b0b5eb72c8f02' },
    { height: 299999, blockHash: '000000000000000067ecc744b5ae34eebbde14d21ca4db51652e4d67e155f07e' },
    { height: 349999, blockHash: '000000000000000002045664f89a1077d0c6c0aaa6dd89b485208cf92d6bbd30' },
    { height: 399999, blockHash: '0000000000000000030034b661aed920a9bdf6bbfa6d2e7a021f78481882fa39' },
    { height: 449999, blockHash: '0000000000000000024c4a35f0485bab79ce341cdd5cc6b15186d9b5b57bf3da' },
    { height: 499999, blockHash: '0000000000000000007962066dcd6675830883516bcf40047d42740a85eb2919' },
    { height: 549999, blockHash: '00000000000000000013dad60a42a3401a8f37ca02f1c00ac5923e674566a3ae' },
    { height: 599999, blockHash: '00000000000000000003ecd827f336c6971f6f77a0b9fba362398dd867975645' },
    { height: 649999, blockHash: '000000000000000000076c1eea129cec5a5291d0ee516c3305df33b0ba76ac51' },
    { height: 699999, blockHash: '0000000000000000000aa3ce000eb559f4143be419108134e0ce71042fc636eb' },
    { height: 749999, blockHash: '00000000000000000001e3aee44a04a5c3461181d25c8803ff6d617173e34533' },
    { height: 799999, blockHash: '000000000000000000012117ad9f72c1c0e42227c2d042dca23e6b96bd9fbb55' },
    { height: 849999, blockHash: '000000000000000000026b072f9347d86942f6786dd1fc362acfd9522715b313' },
    { height: 899999, blockHash: '0000000000000000000196400396be46d0816dc462df4c3450972f589f4d7d24' },
    { height: 949999, blockHash: '00000000000000000000df842728edc58cf64288ca21433257700f3d5b45f286' },
    // The headers-v1 head blob's checkpoint, pinned 2026-10-23 (the same entry as
    // hosaka-core's): derived from headers verified from genesis, cross-checked
    // against blockstream.info and blockchain.info. Head-blob checkpoints sit one
    // every 1,000 blocks (h % 1000 == 999), as every older one does too.
    { height: 971999, blockHash: '00000000000000000000d5c8611c63c98822c10b9ff61cec2d728429a2fd2d82' },
    // Pinned 2026-11-10 (the same entry as ONOSENDAI#658), when nth headers-v1
    // grew the head blob from 971999 to 975226 (arkin0x/nth#10). The head does
    // not end on a checkpoint height this time, so this pin lands INSIDE the
    // head and is verified there; the 227 blocks after it share its difficulty
    // window and end on the manifest's own checkpoint. Cross-checked against
    // blockstream.info and mempool.space, and the 80-byte header from
    // blockstream.info hashes to it.
    { height: 974999, blockHash: '0000000000000000000034698d1530f1294ec6c2937e0e366df8f17a5b614376' },
];
//# sourceMappingURL=checkpoints.js.map