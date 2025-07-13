const fetch = require('node-fetch');
const FormData = require('form-data');

exports.handler = async (event) => {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;

    const { images } = JSON.parse(event.body);

    const uploadAndPreparePromises = images.map(async (base64Image) => {
        const formData = new FormData();
        const imageData = base64Image.split(',')[1];
        formData.append('image', imageData);

        const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
            method: 'POST',
            body: formData,
        });
        const result = await response.json();
        if (!result.success) {
            throw new Error(`Lỗi tải ảnh lên ImgBB: ${result.error.message}`);
        }
            
        return { 
            url: result.data.url, 
            binaryData: Buffer.from(imageData, 'base64')
        };
    });

    const uploadedImages = await Promise.all(uploadAndPreparePromises);

    const captionPromises = uploadedImages.map(async (image) => {
        // *** THAY ĐỔI DUY NHẤT Ở ĐÂY ***
        const response = await fetch(
            "https://api-inference.huggingface.co/models/nlpconnect/vit-gpt2-image-captioning", // <-- ĐÃ THAY ĐỔI MÔ HÌNH
            {
                headers: { 
                    Authorization: `Bearer ${HF_ACCESS_TOKEN}`,
                    "Content-Type": "application/octet-stream"
                },
                method: "POST",
                body: image.binaryData,
            }
        );
        const result = await response.json();
        if (result.error) {
            // Thêm log chi tiết hơn để gỡ lỗi
            console.error("Hugging Face Error:", result.error);
            throw new Error(`Lỗi từ Hugging Face (Captioning): ${result.error}`);
        }
        return { url: image.url, caption: result[0].generated_text };
    });

    const imageAnalyses = await Promise.all(captionPromises);

    let prompt = "Dưới đây là danh sách các bức ảnh được mô tả bằng caption. Hãy sắp xếp chúng theo một trình tự kể chuyện hợp lý nhất. Chỉ trả về một mảng JSON chứa các URL của ảnh theo đúng thứ tự đã sắp xếp.\n\n";
    imageAnalyses.forEach(item => {
        prompt += `Caption: "${item.caption}", URL: ${item.url}\n`;
    });
    prompt += "\nMảng JSON chứa các URL đã sắp xếp:";

    const sortResponse = await fetch(
        "https://api-inference.huggingface.co/models/HuggingFaceH4/zephyr-7b-beta",
        {
            headers: { Authorization: `Bearer ${HF_ACCESS_TOKEN}` },
            method: "POST",
            body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 500 } }),
        }
    );
    const sortResult = await sortResponse.json();
    if (sortResult.error) {
        console.error("Hugging Face Sort Error:", sortResult.error);
        throw new Error(`Lỗi từ Hugging Face (Sorting): ${sortResult.error}`);
    }
    const aiResponseText = sortResult[0].generated_text;
        
    const jsonMatch = aiResponseText.match(/\[\s*".*?"\s*\]/s);
    let sortedUrls;
    if (jsonMatch) {
        try {
            sortedUrls = JSON.parse(jsonMatch[0]);
        } catch (e) {
            sortedUrls = uploadedImages.map(img => img.url);
        }
    } else {
        sortedUrls = uploadedImages.map(img => img.url);
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ sortedImageUrls: sortedUrls }),
    };
};
