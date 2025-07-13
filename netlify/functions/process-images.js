const axios = require('axios');
const FormData = require('form-data'); // Axios vẫn cần form-data, nhưng nó tương thích tốt hơn.

// Hàm chờ
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm gọi API Hugging Face với cơ chế thử lại
async function queryHuggingFace(model, data, token) {
    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${model}`,
            data,
            {
                headers: { 'Authorization': `Bearer ${token}` }
            }
        );
        return response.data;
    } catch (error) {
        // Nếu mô hình đang tải, thử lại sau một khoảng thời gian
        if (error.response && error.response.status === 503) {
            const waitTime = error.response.data.estimated_time || 20;
            await wait(waitTime * 1000);
            return queryHuggingFace(model, data, token);
        }
        throw error; // Ném các lỗi khác
    }
}

exports.handler = async (event) => {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;

    const { images } = JSON.parse(event.body);

    try {
        // --- BƯỚC 1: Tải ảnh lên ImgBB ---
        const uploadPromises = images.map(async (base64Image) => {
            const formData = new FormData();
            const imageData = base64Image.split(',')[1];
            formData.append('image', imageData);

            const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, formData, {
                headers: formData.getHeaders()
            });

            if (!response.data.success) throw new Error(`ImgBB Error: ${response.data.data.error}`);
            return { url: response.data.data.url, binaryData: Buffer.from(imageData, 'base64') };
        });
        const uploadedImages = await Promise.all(uploadPromises);

        // --- BƯỚC 2: Lấy mô tả cho từng ảnh ---
        const captionPromises = uploadedImages.map(async (image) => {
            const result = await queryHuggingFace("nlpconnect/vit-gpt2-image-captioning", image.binaryData, HF_ACCESS_TOKEN);
            if (!result || !result[0] || !result[0].generated_text) throw new Error("Captioning failed");
            return { url: image.url, caption: result[0].generated_text };
        });
        const imageAnalyses = await Promise.all(captionPromises);

        // --- BƯỚC 3: Sắp xếp các mô tả ---
        let prompt = `Analyze the following image captions and return a JSON array of the image URLs, sorted in a logical storytelling order. Only output the JSON array.\n\nCaptions and URLs:\n`;
        imageAnalyses.forEach(item => {
            prompt += `Caption: "${item.caption}", URL: ${item.url}\n`;
        });
            
        const sortPayload = { inputs: prompt, parameters: { max_new_tokens: 512 } };
        const sortResult = await queryHuggingFace("HuggingFaceH4/zephyr-7b-beta", sortPayload, HF_ACCESS_TOKEN);
        if (!sortResult || !sortResult[0] || !sortResult[0].generated_text) throw new Error("Sorting failed");
            
        const aiResponseText = sortResult[0].generated_text;
        const jsonMatch = aiResponseText.match(/\[\s*".*?"\s*\]/s);
        let sortedUrls = jsonMatch ? JSON.parse(jsonMatch[0]) : uploadedImages.map(img => img.url);

        // --- BƯỚC 4: Trả kết quả ---
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
