const axios = require('axios');
const cloudinary = require('cloudinary').v2;

// Cấu hình Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm gọi API Hugging Face
async function queryHuggingFace(model, payload, token) {
    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${model}`,
            payload,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 503) {
            const waitTime = error.response.data.estimated_time || 20;
            await wait(waitTime * 1000);
            return queryHuggingFace(model, payload, token);
        }
        throw error;
    }
}

exports.handler = async (event) => {
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;
    const { images } = JSON.parse(event.body);

    try {
        // --- BƯỚC 1: Tải ảnh lên Cloudinary ---
        const uploadPromises = images.map(async (base64Image) => {
            const response = await cloudinary.uploader.upload(base64Image, { resource_type: "image" });
            return response.secure_url; // Chỉ cần lấy URL
        });
        const imageUrls = await Promise.all(uploadPromises);

        // --- BƯỚC 2: Lấy mô tả cho từng ảnh bằng cách gửi URL ---
        const captionPromises = imageUrls.map(async (url) => {
            // Sử dụng mô hình BLIP lớn, nhưng gửi URL thay vì file
            const result = await queryHuggingFace("Salesforce/blip-image-captioning-large", { inputs: url }, HF_ACCESS_TOKEN);
            if (!result || !result[0] || !result[0].generated_text) throw new Error("Captioning failed");
            return { url: url, caption: result[0].generated_text };
        });
        const imageAnalyses = await Promise.all(captionPromises);

        // --- BƯỚC 3: Sắp xếp các mô tả ---
        let prompt = `Analyze the following image captions and return a JSON array of the image URLs, sorted in a logical storytelling order. Only output the JSON array.\n\nCaptions and URLs:\n`;
        imageAnalyses.forEach(item => {
            prompt += `Caption: "${item.caption}", URL: ${item.url}\n`;
        });
            
        const sortPayload = { inputs: prompt, parameters: { max_new_tokens: 512 } };
        const sortResult = await queryHuggingFace("mistralai/Mistral-7B-Instruct-v0.2", sortPayload, HF_ACCESS_TOKEN);
        if (!sortResult || !sortResult[0] || !sortResult[0].generated_text) throw new Error("Sorting failed");
            
        const aiResponseText = sortResult[0].generated_text;
        const jsonMatch = aiResponseText.match(/\[\s*".*?"\s*\]/s);
        let sortedUrls = jsonMatch ? JSON.parse(jsonMatch[0]) : imageUrls;

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
