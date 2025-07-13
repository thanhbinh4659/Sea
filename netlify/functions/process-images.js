// Import 'node-fetch' để gọi các API khác
const fetch = require('node-fetch');
const FormData = require('form-data');

// Hàm xử lý chính của Function
exports.handler = async (event) => {
    // Lấy các API key từ biến môi trường của Netlify (sẽ cài đặt sau)
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    const HF_ACCESS_TOKEN = process.env.HF_ACCESS_TOKEN;

    // Lấy dữ liệu ảnh (dưới dạng base64) từ request gửi lên
    const { images } = JSON.parse(event.body);

    // --- BƯỚC 1: Tải tất cả ảnh lên ImgBB để lấy URL ---
    const uploadPromises = images.map(async (base64Image) => {
        const formData = new FormData();
        // Tách phần dữ liệu base64 thực sự
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
        return result.data.url;
    });

    const imageUrls = await Promise.all(uploadPromises);

    // --- BƯỚC 2: Lấy mô tả cho từng ảnh từ Hugging Face ---
    const captionPromises = imageUrls.map(async (url) => {
        const response = await fetch(
            "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large",
            {
                headers: { Authorization: `Bearer ${HF_ACCESS_TOKEN}` },
                method: "POST",
                body: JSON.stringify({ inputs: url }),
            }
        );
        const result = await response.json();
        return { url: url, caption: result[0].generated_text };
    });

    const imageAnalyses = await Promise.all(captionPromises);

    // --- BƯỚC 3: Gửi các mô tả để AI sắp xếp ---
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
        
    // Tìm và trích xuất mảng JSON từ text trả về của AI
    const jsonMatch = aiResponseText.match(/\[\s*".*?"\s*\]/s);
    let sortedUrls;
    if (jsonMatch) {
        try {
            sortedUrls = JSON.parse(jsonMatch[0]);
        } catch (e) {
            // Nếu parse lỗi, trả về thứ tự ban đầu
            sortedUrls = imageUrls;
        }
    } else {
        // Nếu không tìm thấy JSON, trả về thứ tự ban-đầu
        sortedUrls = imageUrls;
    }

    // --- BƯỚC 4: Trả kết quả về cho trình duyệt ---
    return {
        statusCode: 200,
        body: JSON.stringify({ sortedImageUrls: sortedUrls }),
    };
};
