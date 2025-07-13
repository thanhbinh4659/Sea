const fetch = require('node-fetch');
const FormData = require('form-data');

exports.handler = async (event) => {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;

    const { images } = JSON.parse(event.body);

    // --- BƯỚC 1: Tải ảnh lên ImgBB VÀ giữ lại dữ liệu ảnh gốc ---
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
            
        // *** THAY ĐỔI QUAN TRỌNG 1: Trả về cả URL và dữ liệu ảnh gốc ***
        return { 
            url: result.data.url, 
            binaryData: Buffer.from(imageData, 'base64') // Chuyển base64 thành dữ liệu nhị phân
        };
    });

    const uploadedImages = await Promise.all(uploadAndPreparePromises);

    // --- BƯỚC 2: Lấy mô tả cho từng ảnh từ Hugging Face ---
    const captionPromises = uploadedImages.map(async (image) => {
        // *** THAY ĐỔI QUAN TRỌNG 2: Gửi dữ liệu nhị phân thay vì URL ***
        const response = await fetch(
            "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large",
            {
                headers: { 
                    Authorization: `Bearer ${HF_ACCESS_TOKEN}`,
                    "Content-Type": "application/octet-stream" // Báo cho HF biết đây là dữ liệu nhị phân
                },
                method: "POST",
                body: image.binaryData, // Gửi thẳng dữ liệu ảnh
            }
        );
        const result = await response.json();
        // Thêm kiểm tra lỗi nếu mô hình đang tải
        if (result.error) {
            throw new Error(`Lỗi từ Hugging Face: ${result.error}`);
        }
        return { url: image.url, caption: result[0].generated_text };
    });

    const imageAnalyses = await Promise.all(captionPromises);

    // --- BƯỚC 3: Gửi các mô tả để AI sắp xếp (Giữ nguyên) ---
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

    // --- BƯỚC 4: Trả kết quả về cho trình duyệt ---
    return {
        statusCode: 200,
        body: JSON.stringify({ sortedImageUrls: sortedUrls }),
    };
};
