document.addEventListener('DOMContentLoaded', () => {
    const uploadButton = document.getElementById('uploadButton');
    const imageUpload = document.getElementById('imageUpload');
    const statusDiv = document.getElementById('status');
    const imageContainer = document.getElementById('image-container');

    // Khi nhấn nút "Chọn Ảnh", hãy kích hoạt input ẩn
    uploadButton.addEventListener('click', () => {
        imageUpload.click();
    });

    // Khi người dùng đã chọn file
    imageUpload.addEventListener('change', async (event) => {
        const files = event.target.files;
        if (files.length === 0) {
            return;
        }

        // Xóa ảnh cũ và hiển thị trạng thái
        imageContainer.innerHTML = '';
        statusDiv.textContent = 'Đang chuẩn bị tải lên...';

        // Chuyển các file ảnh thành dạng base64
        const imagePromises = Array.from(files).map(file => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = error => reject(error);
                reader.readAsDataURL(file);
            });
        });

        try {
            const base64Images = await Promise.all(imagePromises);

            statusDiv.textContent = 'Đang phân tích và sắp xếp... Việc này có thể mất một lúc.';

            // Gửi dữ liệu đến Netlify Function của chúng ta
            const response = await fetch('/.netlify/functions/process-images', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ images: base64Images }),
            });

            if (!response.ok) {
                throw new Error(`Lỗi từ máy chủ: ${response.statusText}`);
            }

            const result = await response.json();
            const sortedUrls = result.sortedImageUrls;

            // Hiển thị các ảnh đã được sắp xếp
            statusDiv.textContent = 'Đã sắp xếp xong!';
            displayImages(sortedUrls);

        } catch (error) {
            console.error('Đã có lỗi xảy ra:', error);
            statusDiv.textContent = `Đã xảy ra lỗi: ${error.message}`;
        }
    });

    function displayImages(urls) {
        imageContainer.innerHTML = ''; // Xóa sạch container
        urls.forEach(url => {
            const imgItem = document.createElement('div');
            imgItem.className = 'image-item';
            const img = document.createElement('img');
            img.src = url;
            imgItem.appendChild(img);
            imageContainer.appendChild(imgItem);
        });
    }
});

