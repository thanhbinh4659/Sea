const axios = require('axios');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function queryHuggingFace(model, data, token) {
    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${model}`,
            data,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 503) {
            const waitTime = error.response.data.estimated_time || 20;
            await wait(waitTime * 1000);
            return queryHuggingFace(model, data, token);
        }
        throw error;
    }
}

exports.handler = async (event) => {
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;
    const { images } = JSON.parse(event.body);

    try {
        const uploadPromises = images.map(async (base64Image) => {
            const response = await cloudinary.uploader.upload(base64Image, { resource_type: "image" });
            const imageBuffer = Buffer.from(base64Image.split(',')[1], 'base64');
            return { url: response.secure_url, binaryData: imageBuffer };
        });
        const uploadedImages = await Promise.all(uploadPromises);

        const captionPromises = uploadedImages.map(async (image) => {
            // *** THAY ĐỔI MÔ HÌNH CAPTION ***
            const result = await queryHuggingFace("Salesforce/blip-image-captioning-base", image.binaryData, HF_ACCESS_TOKEN);
            if (!result || !result[0] || !result[0].generated_text) throw new Error("Captioning failed");
            return { url: image.url, caption: result[0].generated_text };
        });
        const imageAnalyses = await Promise.all(captionPromises);

        let prompt = `Analyze the following image captions and return a JSON array of the image URLs, sorted in a logical storytelling order. Only output the JSON array.\n\nCaptions and URLs:\n`;
        imageAnalyses.forEach(item => {
            prompt += `Caption: "${item.caption}", URL: ${item.url}\n`;
        });
            
        const sortPayload = { inputs: prompt, parameters: { max_new_tokens: 512 } };
        // *** THAY ĐỔI MÔ HÌNH SẮP XẾP ***
        const sortResult = await queryHuggingFace("mistralai/Mistral-7B-Instruct-v0.2", sortPayload, HF_ACCESS_TOKEN);
        if (!sortResult || !sortResult[0] || !sortResult[0].generated_text) throw new Error("Sorting failed");
            
        const aiResponseText = sortResult[0].generated_text;
        const jsonMatch = aiResponseText.match(/\[\s*".*?"\s*\]/s);
        let sortedUrls = jsonMatch ? JSON.parse(jsonMatch[0]) : uploadedImages.map(img => img.url);

        return {
            statusCode: 200,
            body: JSON.stringify({ sortedImageUrls: sortedUrls }),
        };

    } catch (error) {
        console.error("Detailed Error:", error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: `An error occurred: ${error.message}` }),
        };
    }
};
