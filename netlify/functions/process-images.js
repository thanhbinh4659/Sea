import fetch from 'node-fetch';
import FormData from 'form-data';

// Hàm gọi API Hugging Face với cơ chế thử lại
async function queryHuggingFace(model, data, token) {
    const response = await fetch(
        `https://api-inference.huggingface.co/models/${model}`,
        {
            headers: { Authorization: `Bearer ${token}` },
            method: "POST",
            body: data,
        }
    );
    const result = await response.json();
    // Nếu mô hình đang tải, nó sẽ trả về lỗi.
    if (result.error && result.estimated_time) {
         // Chờ một chút rồi thử lại
        await new Promise(resolve => setTimeout(resolve, result.estimated_time * 1000));
        return queryHuggingFace(model, data, token); // Đệ quy
    }
    return result;
}


export const handler = async (event) => {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;

    const { images } = JSON.parse(event.body);

    try {
        // --- BƯỚC 1: Tải ảnh lên ImgBB ---
        const uploadPromises = images.map(async (base64Image) => {
            const formData = new FormData();
            const imageData = base64Image.split(',')[1];
            formData.append('image', imageData);

            const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
                method: 'POST',
                body: formData,
            });
            const result = await response.json();
            if (!result.success) throw new Error(`ImgBB Error: ${result.error.message}`);
                
            return { url: result.data.url, binaryData: Buffer.from(imageData, 'base64') };
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
        let prompt = "Analyze the following image captions and return a JSON array of the image URLs, sorted in a logical storytelling order. Only output the JSON array.\n\nCaptions and URLs:\n";
        imageAnalyses.forEach(item => {
            prompt += `Caption: "${item.caption}", URL: ${item.url}\n`;
        });
            
        const sortResult = await queryHuggingFace("HuggingFaceH4/zephyr-7b-beta", JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 512 } }), HF_ACCESS_TOKEN);
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
        console.error("Detailed Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: `An error occurred: ${error.message}` }),
        };
    }
};
