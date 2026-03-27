import * as ort from 'onnxruntime-node';
import path from 'path';

async function testLoad() {
    const modelPath = path.join(process.cwd(), 'doubt_royale_model_latest.onnx');
    try {
        const session = await ort.InferenceSession.create(modelPath);
        console.log('Verification: Successfully loaded the new ONNX model.');
        
        // Test with dummy input
        const input = new ort.Tensor('float32', new Float32Array(62), [1, 62]);
        const results = await session.run({ input });
        console.log('Verification: Inference successful.');
        console.log('Output keys:', Object.keys(results));
    } catch (e) {
        console.error('Verification failed:', e);
        process.exit(1);
    }
}

testLoad();
