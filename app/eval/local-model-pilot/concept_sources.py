"""Small source index for a local pilot of evidence-based factual questions."""

import re


SOURCES = (
    (
        r"圖形處理器|图形处理器|graphics processing unit|\bGPU\b",
        "https://docs.nvidia.com/cuda/archive/12.8.2/pdf/CUDA_C_Programming_Guide.pdf",
        "GPU 的多线程设计追求吞吐量和内存带宽，通过切换可运行线程来隐藏访存等待；隐藏延迟不等于单次访问延迟低。"
        "SIMT 中每个线程有自己的状态，同一 warp 中的活动线程通常执行同一指令，硬件可以切换和调度不同 warp。",
    ),
    (
        r"buddy\s*system|[夥伙]伴系[統统]",
        "https://www.kernel.org/doc/html/latest/admin-guide/mm/pagemap.html",
        "Linux 的伙伴系统管理物理连续的页块，按 2 的幂组织页块；分裂和合并的单位是页块。",
    ),
    (
        r"slab\s*allocation|平板分配",
        "https://kernel.org/doc/gorman/html/understand/understand011.html",
        "Slab 在从页分配器取得的页上缓存同类内核对象，复用初始化，减少按页服务小对象带来的开销和浪费。"
        "与伙伴系统比较时，先核对两者各自分配的基本单位。",
    ),
    (
        r"task\s*parallelism|data\s*parallelism|[數数][據据]平行|工作平行",
        "https://hpc.llnl.gov/documentation/tutorials/introduction-parallel-computing-tutorial",
        "数据并行是把数据域分块，对各块执行相同操作；功能或任务并行是把计算拆成不同功能，同时执行不同操作。"
        "按题面直接描述的分工判别，只有明确给出不同处理阶段时才以阶段分工为依据。",
    ),
    (
        r"ray[-\s]*tracing|光[線线]追[蹤踪]",
        "https://www.pbr-book.org/4ed/Introduction/pbrt_System_Overview",
        "PBRT 的 CPU 光线追踪将图像分成像素区域，各处理器对自己的区域执行相同的渲染算法。",
    ),
    (
        r"(?:影音|音[頻频]|[視视][頻频])解[碼码]|(?:audio|video) decoding",
        "https://ffmpeg.org/doxygen/trunk/demuxing_decoding_8c-example.html",
        "FFmpeg 分别维护音频解码器和视频解码器的上下文，两路媒体调用各自对应的解码器，产生不同格式的输出。",
    ),
)


def sources_for(text):
    return [{"url": url, "fact": fact} for pattern, url, fact in SOURCES if re.search(pattern, text, re.I)]
